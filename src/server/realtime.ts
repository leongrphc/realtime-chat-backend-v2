import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { z } from 'zod';
import type { Config } from './config';
import type { Resources } from './resources';
import { sessionFor } from './auth';
import { publicError, AppError, uuid } from './core';
import { markRead, requireMember, sendMessage, wire } from './chat';
import { presence, rateLimit, touchPresence } from './resources';
import { clientAddress, trustedEdge } from './proxy';
export async function recipients(r: Resources, conversationId: string) {
  return (await r.db.membership.findMany({ where: { conversationId }, select: { userId: true } })).map(m => `user:${m.userId}`);
}
export async function peers(r: Resources, userId: string) {
  const members = await r.db.membership.findMany({ where: { conversation: { members: { some: { userId } } } }, select: { userId: true } });
  return [...new Set(members.map(m => m.userId))];
}
export async function publishMessage(io: Server, r: Resources, result: Awaited<ReturnType<typeof sendMessage>>) {
  if (!result.created) return;
  const rooms = await recipients(r, result.message.conversationId);
  io.to(rooms).emit('message:new', wire(result.message));
  const notifications = await r.db.notification.findMany({ where: { messageId: result.message.id } });
  for (const notification of notifications) io.to(`user:${notification.userId}`).emit('notification:new', wire(notification));
}
export async function realtime(http: HttpServer, r: Resources, config: Config) {
  const pub = r.redis.duplicate();
  const sub = r.redis.duplicate();
  pub.on('error', () => console.error('Socket Redis publisher error'));
  sub.on('error', () => console.error('Socket Redis subscriber error'));
  await Promise.all([pub.connect(), sub.connect()]);
  const io = new Server(http, { transports: ['websocket'], maxHttpBufferSize: 20000,
    cors: { origin: config.WEB_ORIGIN, credentials: true },
    allowRequest: (req, callback) => callback(null, req.headers.origin === config.WEB_ORIGIN && (!config.EDGE_PROXY_SECRET || trustedEdge(req, config))) });
  io.adapter(createAdapter(pub, sub));
  let closing = false;
  const pending = new Set<Promise<unknown>>();
  const report = () => console.error('Realtime dependency error');
  const background = (task: Promise<unknown>) => {
    pending.add(task);
    void task.catch(report).finally(() => pending.delete(task));
  };
  io.use(async (socket, next) => {
    try {
      await rateLimit(r, `socket-connect:${clientAddress(socket.request, config)}`, 60);
      const session = await sessionFor(r, socket.handshake.headers.cookie);
      socket.data.userId = session.userId;
      socket.data.sessionId = session.id;
      socket.data.expiresAt = session.expiresAt.getTime();
      next();
    } catch { next(new Error('UNAUTHENTICATED')); }
  });
  const broadcastPresence = async (userId: string) => {
    const online = await presence(r, userId);
    const rooms = (await peers(r, userId)).map(id => `user:${id}`);
    if (!closing) io.to(rooms).emit('presence:update', { userId, online });
  };
  io.on('connection', socket => {
    const userId = socket.data.userId as string;
    socket.join([`user:${userId}`, `session:${socket.data.sessionId}`]);
    const refresh = async () => {
      if (!socket.connected || closing) return;
      await touchPresence(r, userId, socket.id);
      if (!socket.connected) await r.redis.zRem(`presence:${userId}`, socket.id);
    };
    background(refresh().then(() => broadcastPresence(userId)));
    const heartbeat = setInterval(() => { background(refresh()); }, 15000);
    // Node timers cannot exceed ~24 days. Sessions may last 30 days.
    const expiry = setInterval(() => { if (Date.now() >= socket.data.expiresAt) socket.disconnect(true); }, 10000);
    type Ack = (response: unknown) => void;
    const handler = (event: string, limit: number, action: (input: unknown) => Promise<unknown>) => {
      socket.on(event, (input: unknown, ack?: Ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        background((async () => {
          try {
            if (Date.now() >= socket.data.expiresAt) throw new AppError(401, 'UNAUTHENTICATED');
            const valid = await r.db.session.findUnique({ where: { id: socket.data.sessionId } });
            if (!valid) throw new AppError(401, 'UNAUTHENTICATED');
            await rateLimit(r, `${event}:${userId}`, limit);
            reply({ ok: true, data: wire(await action(input)) });
          } catch (error) {
            const { code, status } = publicError(error);
            if (status === 500) report();
            reply({ ok: false, error: code });
          }
        })());
      });
    };
    handler('message:send', 60, async input => {
      const result = await sendMessage(r, userId, input);
      // Messages remain committed if Redis publishing fails; a retry returns the saved message.
      await publishMessage(io, r, result).catch(report);
      return result.message;
    });
    handler('typing:set', 120, async input => {
      const data = z.object({ conversationId: uuid, typing: z.boolean() }).parse(input);
      await requireMember(r, userId, data.conversationId);
      io.to(await recipients(r, data.conversationId)).except(`user:${userId}`).emit('typing:update', { ...data, userId });
      return null;
    });
    handler('message:read', 120, async input => {
      const receipt = await markRead(r, userId, input);
      io.to(await recipients(r, receipt.conversationId)).emit('receipt:update', receipt);
      return receipt;
    });
    socket.on('disconnect', () => {
      clearInterval(heartbeat); clearInterval(expiry);
      background(r.redis.zRem(`presence:${userId}`, socket.id).then(() => broadcastPresence(userId)));
    });
  });
  return { io, async close() {
    closing = true;
    await new Promise<void>(resolve => io.close(() => resolve()));
    await Promise.allSettled([...pending]);
    await Promise.all([pub.quit(), sub.quit()]);
  } };
}
