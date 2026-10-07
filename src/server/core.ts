import { randomBytes, scrypt as rawScrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
const scrypt = promisify(rawScrypt);
export class AppError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function publicError(error: unknown) {
  if (error instanceof AppError) return { status: error.status, code: error.code };
  if (error instanceof z.ZodError) return { status: 400, code: 'INVALID_INPUT' };
  return { status: 500, code: 'INTERNAL_ERROR' };
}
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [salt, hex] = hash.split(':');
  if (!salt || !hex || hex.length !== 128) return false;
  const derived = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(derived, Buffer.from(hex, 'hex'));
}
export const uuid = z.uuid();
export const loginSchema = z.object({ email: z.email().max(254).transform(v => v.toLowerCase()), password: z.string().min(10).max(128) });
export const registerSchema = loginSchema.extend({ name: z.string().trim().min(1).max(60) });
export const sendSchema = z.object({
  conversationId: uuid, clientId: uuid, body: z.string().trim().max(4000).default(''),
  attachmentIds: z.array(uuid).max(5).default([])
}).refine(v => v.body.length > 0 || v.attachmentIds.length > 0).refine(v => new Set(v.attachmentIds).size === v.attachmentIds.length);
export const createConversationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), userIds: z.array(uuid).length(1) }),
  z.object({ kind: z.literal('group'), name: z.string().trim().min(1).max(80), userIds: z.array(uuid).min(1).max(19) })
]);
export const paginationSchema = z.object({ cursor: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export const readSchema = z.object({ conversationId: uuid, messageId: uuid });
export function directKey(a: string, b: string) { return [a, b].sort().join(':'); }
export const safeUser = { id: true, name: true, email: true } as const;
export function detectFile(buffer: Buffer, declared: string) {
  const types: Record<string, boolean> = {
    'image/png': buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    'image/jpeg': buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255,
    'application/pdf': buffer.subarray(0, 5).toString() === '%PDF-',
    'application/zip': buffer[0] === 80 && buffer[1] === 75 && [3,5,7].includes(buffer[2]),
    'text/plain': !buffer.includes(0) && Buffer.from(buffer.toString('utf8')).equals(buffer)
  };
  if (!types[declared]) throw new AppError(400, 'UNSUPPORTED_FILE');
  return declared;
}
export function safeFilename(name: string) {
  return [...name].map(c => c === '/' || c === '\\' || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? '_' : c).join('').slice(0, 120) || 'file';
}
