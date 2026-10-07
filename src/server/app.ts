import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from './config';
import { resources, rateLimit, presence } from './resources';
import { clearSessionCookie, createSession, sessionFor } from './auth';
import { AppError, detectFile, hashPassword, loginSchema, publicError, registerSchema, safeFilename, safeUser, uuid, verifyPassword } from './core';
import { createConversation, listConversations, listMessages, listNotifications, markRead, requireMember, sendMessage, wire } from './chat';
import { peers, publishMessage, realtime, recipients } from './realtime';
import { clientAddress, trustedEdge } from './proxy';
export async function createApplication(config: Config) {
  const r = resources(config);
  await Promise.all([r.db.$connect(), r.redis.connect()]);
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '32kb' }));
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const http = createServer(app);
  const rt = await realtime(http, r, config);
  app.get('/health/live', (_req, res) => { res.json({ status: 'ok' }); });
  app.get('/health/ready', async (_req, res) => {
    try {
      await Promise.all([r.db.$queryRaw`SELECT 1`, r.redis.set('health:write-probe', '1', { EX: 5 }),
        ...(config.UPLOADS_ENABLED ? [r.s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }))] : [])]);
      res.json({ status: 'ready' });
    } catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.use('/api', async (req, _res, next) => {
    if (config.EDGE_PROXY_SECRET && !trustedEdge(req, config)) throw new AppError(403, 'FORBIDDEN');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== config.WEB_ORIGIN) throw new AppError(403, 'INVALID_ORIGIN');
    await rateLimit(r, `http:${clientAddress(req, config)}`, 300);
    next();
  });
  app.post('/api/auth/register', async (req, res) => {
    await rateLimit(r, `auth:${clientAddress(req, config)}`, 10);
    const data = registerSchema.parse(req.body);
    const passwordHash = await hashPassword(data.password);
    try {
      const user = await r.db.user.create({ data: { email: data.email, name: data.name, passwordHash }, select: safeUser });
      await createSession(r, config, user.id, res);
      res.status(201).json(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new AppError(409, 'EMAIL_UNAVAILABLE');
      throw error;
    }
  });
  app.post('/api/auth/login', async (req, res) => {
    await rateLimit(r, `auth:${clientAddress(req, config)}`, 10);
    const data = loginSchema.parse(req.body);
    const user = await r.db.user.findUnique({ where: { email: data.email } });
    const valid = await verifyPassword(data.password, user?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`);
    if (!user || !valid) throw new AppError(401, 'INVALID_CREDENTIALS');
    await createSession(r, config, user.id, res);
    res.json({ id: user.id, name: user.name, email: user.email });
  });
  app.use('/api', async (req, res, next) => {
    const session = await sessionFor(r, req.headers.cookie);
    res.locals.user = session.user;
    res.locals.session = session;
    await rateLimit(r, `user:${session.userId}`, 240);
    next();
  });
  app.get('/api/auth/me', (_req, res) => { res.json(res.locals.user); });
  app.post('/api/auth/logout', async (_req, res) => {
    await r.db.session.deleteMany({ where: { id: res.locals.session.id } });
    rt.io.in(`session:${res.locals.session.id}`).disconnectSockets(true);
    clearSessionCookie(config, res);
    res.status(204).end();
  });
  app.get('/api/users', async (req, res) => {
    const q = z.string().trim().max(100).parse(req.query.q ?? '');
    res.json(await r.db.user.findMany({ where: { id: { not: res.locals.user.id }, OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] }, select: safeUser, take: 30, orderBy: { name: 'asc' } }));
  });
  app.get('/api/presence', async (_req, res) => {
    const ids = await peers(r, res.locals.user.id);
    res.json(await Promise.all(ids.map(async userId => ({ userId, online: await presence(r, userId) }))));
  });
  app.get('/api/conversations', async (_req, res) => { res.json(wire(await listConversations(r, res.locals.user.id))); });
  app.post('/api/conversations', async (req, res) => {
    await rateLimit(r, `conversation:${res.locals.user.id}`, 20);
    const conversation = await createConversation(r, res.locals.user.id, req.body);
    rt.io.to(await recipients(r, conversation.id)).emit('conversation:update', { conversationId: conversation.id });
    res.status(201).json(wire(conversation));
  });
  app.get('/api/conversations/:id/messages', async (req, res) => { res.json(wire(await listMessages(r, res.locals.user.id, String(req.params.id), req.query))); });
  app.post('/api/messages', async (req, res) => {
    await rateLimit(r, `message:send:${res.locals.user.id}`, 60);
    const result = await sendMessage(r, res.locals.user.id, req.body);
    await publishMessage(rt.io, r, result).catch(() => console.error('Message publication failed'));
    res.status(result.created ? 201 : 200).json(wire(result.message));
  });
  app.post('/api/read', async (req, res) => {
    const receipt = await markRead(r, res.locals.user.id, req.body);
    rt.io.to(await recipients(r, receipt.conversationId)).emit('receipt:update', receipt);
    res.json(receipt);
  });
  app.get('/api/notifications', async (req, res) => { res.json(wire(await listNotifications(r, res.locals.user.id, req.query))); });
  app.post('/api/notifications/:id/read', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const result = await r.db.notification.updateMany({ where: { id, userId: res.locals.user.id }, data: { readAt: new Date() } });
    if (!result.count) throw new AppError(404, 'NOT_FOUND');
    res.status(204).end();
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
  app.post('/api/conversations/:id/files', async (req, res, next) => {
    if (!config.UPLOADS_ENABLED) throw new AppError(503, 'UPLOADS_DISABLED');
    await requireMember(r, res.locals.user.id, String(req.params.id));
    await rateLimit(r, `upload:${res.locals.user.id}`, 10);
    next();
  }, upload.single('file'), async (req, res) => {
    if (!req.file?.size) throw new AppError(400, 'EMPTY_FILE');
    const mime = detectFile(req.file.buffer, req.file.mimetype);
    const name = safeFilename(req.file.originalname);
    const key = `${req.params.id}/${randomUUID()}`;
    await r.s3.send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: req.file.buffer, ContentType: 'application/octet-stream' }));
    try {
      const file = await r.db.attachment.create({ data: { conversationId: String(req.params.id), uploaderId: res.locals.user.id, key, name, mime, size: req.file.size }, select: { id: true, name: true, mime: true, size: true } });
      res.status(201).json(file);
    } catch (error) {
      await r.s3.send(new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key })).catch(() => {});
      throw error;
    }
  });
  app.get('/api/files/:id/download', async (req, res) => {
    if (!config.UPLOADS_ENABLED) throw new AppError(503, 'UPLOADS_DISABLED');
    const id = uuid.parse(req.params.id);
    const file = await r.db.attachment.findUnique({ where: { id } });
    if (!file) throw new AppError(404, 'NOT_FOUND');
    await requireMember(r, res.locals.user.id, file.conversationId);
    if (!file.messageId && file.uploaderId !== res.locals.user.id) throw new AppError(403, 'FORBIDDEN');
    const url = await getSignedUrl(r.downloadS3, new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: file.key,
      ResponseContentType: 'application/octet-stream', ResponseContentDisposition: `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name)}` }), { expiresIn: 60 });
    res.json({ url, expiresIn: 60 });
  });
  app.use((_req, res) => { res.status(404).json({ error: 'NOT_FOUND' }); });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof multer.MulterError) { res.status(400).json({ error: 'INVALID_UPLOAD' }); return; }
    if (error instanceof SyntaxError || error?.type === 'entity.too.large') { res.status(400).json({ error: 'INVALID_INPUT' }); return; }
    const { status, code } = publicError(error);
    if (status === 500) console.error('Request failed', error instanceof Error ? error.name : 'UnknownError');
    if (status === 429) res.setHeader('Retry-After', '60');
    res.status(status).json({ error: code });
  };
  app.use(errors);
  return { app, http, r, io: rt.io, async close() {
    await rt.close();
    if (http.listening) await new Promise<void>((resolve, reject) => http.close(err => err ? reject(err) : resolve()));
    await Promise.all([r.db.$disconnect(), r.redis.quit()]);
    r.s3.destroy(); r.downloadS3.destroy();
  } };
}
