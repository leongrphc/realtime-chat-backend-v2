import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createApplication } from '../src/server/app';
import { readConfig } from '../src/server/config';
import { rateLimit } from '../src/server/resources';
import type { Conversation, Message, User } from '../src/app/types';
import { sendMessage } from '../src/server/chat';
let server: Awaited<ReturnType<typeof createApplication>>;
let base: string;
const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
const sockets: Socket[] = [];
const accounts: { user: User; cookie: string }[] = [];
let room: Conversation;
async function request(path: string, cookie = '', data?: unknown, method = data === undefined ? 'GET' : 'POST', requestOrigin = origin) {
  const response = await fetch(`${base}${path}`, { method, headers: { Origin: requestOrigin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const body = response.status === 204 ? null : await response.json();
  return { status: response.status, body, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}
async function connect(cookie: string, url = base) {
  const socket = io(url, { transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: cookie, Origin: origin } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}
function event<T>(socket: Socket, name: string, predicate: (data: T) => boolean = () => true): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error(`Missing ${name}`)); }, 5000);
    const listener = (data: T) => { if (predicate(data)) { clearTimeout(timer); socket.off(name, listener); resolve(data); } };
    socket.on(name, listener);
  });
}
function ack<T>(socket: Socket, name: string, input: unknown): Promise<{ ok: boolean; data: T; error?: string }> {
  return new Promise((resolve, reject) => { socket.timeout(5000).emit(name, input, (err: Error | null, result: { ok: boolean; data: T; error?: string }) => err ? reject(err) : resolve(result)); });
}
beforeAll(async () => {
  if (!process.env.DATABASE_URL?.split('?')[0].endsWith('_test') || !process.env.S3_BUCKET?.endsWith('-test')) throw new Error('Use npm run test:integration with isolated test resources.');
  server = await createApplication(readConfig());
  await server.r.db.notification.deleteMany();
  await server.r.db.attachment.deleteMany();
  await server.r.db.message.deleteMany();
  await server.r.db.conversation.deleteMany();
  await server.r.db.user.deleteMany();
  await server.r.redis.flushDb();
  await server.r.s3.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET }));
  await new Promise<void>(resolve => server.http.listen(0, '127.0.0.1', resolve));
  const address = server.http.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  base = `http://127.0.0.1:${address.port}`;
  for (const name of ['Ada', 'Bora', 'Cem']) {
    const res = await request('/api/auth/register', '', { name, email: `${name.toLowerCase()}@test.local`, password: 'DemoPassword123!' });
    expect(res.status).toBe(201); accounts.push({ user: res.body, cookie: res.cookie });
  }
  const res = await request('/api/conversations', accounts[0].cookie, { kind: 'direct', userIds: [accounts[1].user.id] });
  expect(res.status).toBe(201); room = res.body;
});
afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  if (!server) return;
  const objects = await server.r.s3.send(new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET }));
  if (objects.Contents?.length) await server.r.s3.send(new DeleteObjectsCommand({ Bucket: process.env.S3_BUCKET, Delete: { Objects: objects.Contents.map(o => ({ Key: o.Key })) } }));
  await server.r.s3.send(new DeleteBucketCommand({ Bucket: process.env.S3_BUCKET }));
  await server.close();
});
describe('real PostgreSQL, Redis, S3 and Socket.IO integration', () => {
  it('has live/readiness checks and secure cookie sessions', async () => {
    expect((await request('/health/live')).status).toBe(200);
    expect((await request('/health/ready')).status).toBe(200);
    expect((await request('/api/auth/me')).status).toBe(401);
    expect((await request('/api/auth/me', accounts[0].cookie)).body.id).toBe(accounts[0].user.id);
    expect((await request('/api/auth/login', '', { email: 'ada@test.local', password: 'wrongpassword' })).status).toBe(401);
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ada@test.local', password: 'DemoPassword123!' }) });
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(JSON.stringify(await response.json())).not.toContain('passwordHash');
  });
  it('blocks CSRF, outsiders and invalid membership requests', async () => {
    expect((await request('/api/messages', accounts[0].cookie, { body: 'hi' }, 'POST', 'https://attacker.invalid')).status).toBe(403);
    expect((await request(`/api/conversations/${room.id}/messages`, accounts[2].cookie)).status).toBe(403);
    expect((await request('/api/messages', accounts[2].cookie, { conversationId: room.id, body: 'bad', clientId: randomUUID() })).status).toBe(403);
    expect((await request('/api/conversations', accounts[0].cookie, { kind: 'group', name: 'Bad', userIds: [accounts[0].user.id] })).status).toBe(400);
  });
  it('reuses direct conversations and creates authorized groups', async () => {
    const result = await request('/api/conversations', accounts[1].cookie, { kind: 'direct', userIds: [accounts[0].user.id] });
    expect(result.body.id).toBe(room.id);
    const group = await request('/api/conversations', accounts[0].cookie, { kind: 'group', name: 'Test group', userIds: accounts.slice(1).map(a => a.user.id) });
    expect(group.body.members).toHaveLength(3);
    expect((await request(`/api/conversations/${group.body.id}/messages`, accounts[2].cookie)).status).toBe(200);
  });
  it('sends once under concurrent retries, with transactional notifications and conflicts', async () => {
    const data = { conversationId: room.id, clientId: randomUUID(), body: 'Idempotent demo message' };
    const results = await Promise.all(Array.from({ length: 8 }, () => request('/api/messages', accounts[0].cookie, data)));
    expect(new Set(results.map(r => r.body.id)).size).toBe(1);
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    expect(await server.r.db.notification.count({ where: { messageId: results[0].body.id } })).toBe(1);
    expect((await request('/api/messages', accounts[0].cookie, { ...data, body: 'changed' })).status).toBe(409);
  });
  it('paginates stable message cursors and scopes search', async () => {
    for (let i = 0; i < 5; i++) await sendMessage(server.r, accounts[0].user.id, { conversationId: room.id, clientId: randomUUID(), body: `searchable ${i}` });
    const first = await request(`/api/conversations/${room.id}/messages?limit=2`, accounts[1].cookie);
    const second = await request(`/api/conversations/${room.id}/messages?limit=2&cursor=${first.body.nextCursor}`, accounts[1].cookie);
    expect(first.body.items).toHaveLength(2);
    expect(second.body.items).toHaveLength(2);
    expect(first.body.items.map((m: Message) => m.id).some((id: string) => second.body.items.some((m: Message) => m.id === id))).toBe(false);
    expect((await request(`/api/conversations/${room.id}/messages?q=searchable`, accounts[1].cookie)).body.items).toHaveLength(5);
    expect((await request(`/api/conversations/${room.id}/messages?cursor=${randomUUID()}`, accounts[1].cookie)).status).toBe(400);
    expect((await request(`/api/conversations/${room.id}/messages?limit=1000`, accounts[1].cookie)).status).toBe(400);
  });
  it('keeps receipts monotonic and notifications private and durable', async () => {
    const page = await request(`/api/conversations/${room.id}/messages`, accounts[1].cookie);
    const latest: Message = page.body.items[0];
    const oldest: Message = page.body.items.at(-1);
    expect((await request('/api/read', accounts[1].cookie, { conversationId: room.id, messageId: latest.id })).body.lastReadSeq).toBe(latest.seq);
    expect((await request('/api/read', accounts[1].cookie, { conversationId: room.id, messageId: oldest.id })).body.lastReadSeq).toBe(latest.seq);
    expect((await request('/api/notifications', accounts[1].cookie)).body.unread).toBe(0);
    const notices = (await request('/api/notifications?limit=2', accounts[1].cookie)).body;
    expect(notices.items).toHaveLength(2); expect(notices.nextCursor).toBeTruthy();
    expect((await request(`/api/notifications/${notices.items[0].id}/read`, accounts[2].cookie, {})).status).toBe(404);
    expect((await request(`/api/notifications?cursor=${notices.items[0].id}`, accounts[2].cookie)).status).toBe(400);
  });
  it('authorizes uploads/downloads, verifies MIME and claims attachments once', async () => {
    const form = new FormData(); form.append('file', new Blob(['demo file content'], { type: 'text/plain' }), 'demo.txt');
    const upload = await fetch(`${base}/api/conversations/${room.id}/files`, { method: 'POST', headers: { Origin: origin, Cookie: accounts[0].cookie }, body: form });
    expect(upload.status).toBe(201); const file = await upload.json();
    expect((await request(`/api/files/${file.id}/download`, accounts[1].cookie)).status).toBe(403);
    const data = { conversationId: room.id, clientId: randomUUID(), body: '', attachmentIds: [file.id] };
    expect((await request('/api/messages', accounts[0].cookie, data)).status).toBe(201);
    expect((await request('/api/messages', accounts[0].cookie, data)).status).toBe(200);
    expect((await request('/api/messages', accounts[0].cookie, { ...data, clientId: randomUUID() })).status).toBe(400);
    expect((await request(`/api/files/${file.id}/download`, accounts[2].cookie)).status).toBe(403);
    const signed = await request(`/api/files/${file.id}/download`, accounts[1].cookie);
    const download = await fetch(signed.body.url);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(await download.text()).toBe('demo file content');
    const bad = new FormData(); bad.append('file', new Blob(['not a png'], { type: 'image/png' }), 'bad.png');
    expect((await fetch(`${base}/api/conversations/${room.id}/files`, { method: 'POST', headers: { Origin: origin, Cookie: accounts[0].cookie }, body: bad })).status).toBe(400);
    const tooLarge = new FormData(); tooLarge.append('file', new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'text/plain' }), 'large.txt');
    expect((await fetch(`${base}/api/conversations/${room.id}/files`, { method: 'POST', headers: { Origin: origin, Cookie: accounts[0].cookie }, body: tooLarge })).status).toBe(400);
  });
  it('enforces atomic distributed rate limits', async () => {
    const key = `test:${randomUUID()}`;
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => rateLimit(server.r, key, 3, 200)));
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(3);
    expect(attempts.filter(a => a.status === 'rejected')).toHaveLength(9);
    await new Promise(resolve => setTimeout(resolve, 250));
    await expect(rateLimit(server.r, key, 3, 200)).resolves.toBeUndefined();
    await server.r.redis.set(`limit:message:send:${accounts[0].user.id}`, '60', { EX: 60 });
    expect((await request('/api/messages', accounts[0].cookie, { conversationId: room.id, clientId: randomUUID(), body: 'limited' })).status).toBe(429);
    await server.r.redis.del(`limit:message:send:${accounts[0].user.id}`);
  });
  it('delivers realtime messages, typing and receipts, and blocks unauthorized socket actions', async () => {
    const ada = await connect(accounts[0].cookie);
    const bora = await connect(accounts[1].cookie);
    const cem = await connect(accounts[2].cookie);
    const incoming = event<Message>(bora, 'message:new');
    const notice = event<{ messageId: string }>(bora, 'notification:new');
    const data = { conversationId: room.id, clientId: randomUUID(), body: 'socket demo' };
    const result = await ack<Message>(ada, 'message:send', data);
    expect(result.ok).toBe(true);
    expect((await incoming).id).toBe(result.data.id);
    expect((await notice).messageId).toBe(result.data.id);
    expect((await ack<Message>(ada, 'message:send', data)).data.id).toBe(result.data.id);
    const typing = event<{ typing: boolean }>(bora, 'typing:update');
    expect((await ack(ada, 'typing:set', { conversationId: room.id, typing: true })).ok).toBe(true);
    expect((await typing).typing).toBe(true);
    const receipt = event<{ lastReadSeq: string }>(ada, 'receipt:update');
    expect((await ack(bora, 'message:read', { conversationId: room.id, messageId: result.data.id })).ok).toBe(true);
    expect((await receipt).lastReadSeq).toBe(result.data.seq);
    expect((await ack(cem, 'typing:set', { conversationId: room.id, typing: true })).error).toBe('FORBIDDEN');
    expect((await ack(cem, 'message:send', { ...data, clientId: randomUUID() })).error).toBe('FORBIDDEN');
    const group = await request('/api/conversations', accounts[0].cookie, { kind: 'group', name: 'Realtime demo group', userIds: accounts.slice(1).map(a => a.user.id) });
    const groupBora = event<Message>(bora, 'message:new', m => m.conversationId === group.body.id);
    const groupCem = event<Message>(cem, 'message:new', m => m.conversationId === group.body.id);
    const groupSend = await ack<Message>(ada, 'message:send', { conversationId: group.body.id, clientId: randomUUID(), body: 'Group demo message' });
    expect((await groupBora).id).toBe(groupSend.data.id);
    expect((await groupCem).id).toBe(groupSend.data.id);
    expect(await server.r.db.notification.count({ where: { messageId: groupSend.data.id } })).toBe(2);
  });
  it('broadcasts messages and receipts across two API processes via Redis', async () => {
    const other = await createApplication(readConfig());
    let remote: Socket | undefined;
    try {
      await new Promise<void>(resolve => other.http.listen(0, '127.0.0.1', resolve));
      const address = other.http.address();
      if (!address || typeof address === 'string') throw new Error('Missing port');
      remote = await connect(accounts[0].cookie, `http://127.0.0.1:${address.port}`);
      const incoming = event<Message>(sockets[1], 'message:new', m => m.body === 'Cross-process demo');
      const sent = await ack<Message>(remote, 'message:send', { conversationId: room.id, clientId: randomUUID(), body: 'Cross-process demo' });
      expect((await incoming).id).toBe(sent.data.id);
      const receipt = event<{ lastReadSeq: string }>(remote, 'receipt:update', r => r.lastReadSeq === sent.data.seq);
      await request('/api/read', accounts[1].cookie, { conversationId: room.id, messageId: sent.data.id });
      expect((await receipt).lastReadSeq).toBe(sent.data.seq);
    } finally { remote?.disconnect(); await other.close(); }
  });
  it('tracks multiple connections, expires stale presence and revokes logged-out sessions', async () => {
    const first = sockets[0];
    const second = await connect(accounts[0].cookie);
    const observer = sockets[1];
    first.disconnect();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await request('/api/presence', accounts[1].cookie)).body.find((p: { userId: string }) => p.userId === accounts[0].user.id).online).toBe(true);
    await server.r.redis.zAdd(`presence:${accounts[2].user.id}`, { value: 'crashed-worker', score: Date.now() - 1 });
    await request('/api/presence', accounts[0].cookie);
    expect(await server.r.redis.zScore(`presence:${accounts[2].user.id}`, 'crashed-worker')).toBeNull();
    const offline = event<{ userId: string; online: boolean }>(observer, 'presence:update', p => p.userId === accounts[0].user.id && !p.online);
    const disconnected = event(second, 'disconnect');
    expect((await request('/api/auth/logout', accounts[0].cookie, {})).status).toBe(204);
    await disconnected; expect((await offline).online).toBe(false);
    expect((await request('/api/auth/me', accounts[0].cookie)).status).toBe(401);
    await expect(connect(accounts[0].cookie)).rejects.toThrow('UNAUTHENTICATED');
  });
  it('reports unavailable dependencies as unready while liveness remains healthy', async () => {
    await server.r.redis.quit();
    try {
      expect((await request('/health/ready')).status).toBe(503);
      expect((await request('/health/live')).status).toBe(200);
    } finally { await server.r.redis.connect(); }
    expect((await request('/health/ready')).status).toBe(200);
  });

});
