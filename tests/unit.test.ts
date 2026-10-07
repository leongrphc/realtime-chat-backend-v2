import { describe, expect, it } from 'vitest';
import { AppError, detectFile, directKey, hashPassword, paginationSchema, publicError, safeFilename, sendSchema, tokenHash, verifyPassword } from '../src/server/core';
const conversationId = '10000000-0000-4000-8000-000000000001';
const clientId = '20000000-0000-4000-8000-000000000001';
describe('security and input contracts', () => {
  it('salts password hashes and rejects incorrect passwords', async () => {
    const a = await hashPassword('DemoPassword123!');
    const b = await hashPassword('DemoPassword123!');
    expect(a).not.toBe(b);
    expect(await verifyPassword('DemoPassword123!', a)).toBe(true);
    expect(await verifyPassword('wrong password', a)).toBe(false);
    expect(await verifyPassword('anything', 'invalid')).toBe(false);
  });
  it('rejects empty sends, duplicate attachments, oversize messages and non-UUID keys', () => {
    expect(sendSchema.safeParse({ conversationId, clientId, body: '' }).success).toBe(false);
    expect(sendSchema.safeParse({ conversationId, clientId, body: 'x'.repeat(4001) }).success).toBe(false);
    expect(sendSchema.safeParse({ conversationId, clientId: 'bad', body: 'hi' }).success).toBe(false);
    expect(sendSchema.safeParse({ conversationId, clientId, attachmentIds: [clientId, clientId] }).success).toBe(false);
    expect(sendSchema.parse({ conversationId, clientId, body: '  hi  ' }).body).toBe('hi');
    expect(sendSchema.safeParse({ conversationId, clientId, attachmentIds: [clientId] }).success).toBe(true);
  });
  it('bounds pagination and makes direct conversation keys symmetric', () => {
    expect(paginationSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(paginationSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(paginationSchema.parse({}).limit).toBe(30);
    expect(directKey('b', 'a')).toBe(directKey('a', 'b'));
  });
  it('rejects active file types and MIME spoofing; cleans filenames', () => {
    expect(() => detectFile(Buffer.from('<script>bad</script>'), 'text/html')).toThrow(AppError);
    expect(() => detectFile(Buffer.from('not png'), 'image/png')).toThrow(AppError);
    expect(() => detectFile(Buffer.from([0, 255]), 'text/plain')).toThrow(AppError);
    expect(detectFile(Buffer.from('demo text'), 'text/plain')).toBe('text/plain');
    expect(detectFile(Buffer.from('%PDF-1.7\n'), 'application/pdf')).toBe('application/pdf');
    expect(safeFilename('../a\r\n.txt')).toBe('.._a__.txt');
  });
  it('hashes session tokens and does not expose internal exception details', () => {
    expect(tokenHash('demo')).toMatch(/^[0-9a-f]{64}$/);
    expect(publicError(new Error('database password'))).toEqual({ status: 500, code: 'INTERNAL_ERROR' });
    expect(publicError(new AppError(403, 'FORBIDDEN'))).toEqual({ status: 403, code: 'FORBIDDEN' });
  });
});

import { mergeConversations, mergeMessages } from '../src/app/state';
import type { Conversation, Message } from '../src/app/types';
describe('realtime and HTTP reconciliation', () => {
  it('does not regress receipts when an older HTTP snapshot arrives after a socket update', () => {
    const conversation: Conversation = { id: conversationId, kind: 'direct', name: null, members: [
      { userId: clientId, role: 'member', lastReadSeq: '9007199254740995', user: { id: clientId, name: 'Demo', email: 'demo@test.local' } }
    ] };
    const stale: Conversation = { ...conversation, members: [{ ...conversation.members[0], lastReadSeq: '9007199254740993' }] };
    expect(mergeConversations([conversation], [stale])[0].members[0].lastReadSeq).toBe('9007199254740995');
    expect(mergeConversations([stale], [conversation])[0].members[0].lastReadSeq).toBe('9007199254740995');
  });
  it('deduplicates replayed messages and preserves BigInt sequence order', () => {
    const a: Message = { id: conversationId, seq: '9007199254740993', conversationId, senderId: clientId, clientId, body: 'demo', createdAt: new Date().toISOString(), sender: { id: clientId, name: 'Demo', email: 'demo@test.local' }, attachments: [] };
    const b = { ...a, id: clientId, seq: '9007199254740995' };
    expect(mergeMessages([b, a], [a, b]).map(m => m.id)).toEqual([a.id, b.id]);
  });
});
