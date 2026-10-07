import { randomBytes } from 'node:crypto';
import { parse, serialize } from 'cookie';
import type { Response } from 'express';
import type { Config } from './config';
import type { Resources } from './resources';
import { AppError, safeUser, tokenHash } from './core';
export async function sessionFor(r: Resources, cookie?: string) {
  const token = parse(cookie ?? '').chat_session;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new AppError(401, 'UNAUTHENTICATED');
  const session = await r.db.session.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: { select: safeUser } } });
  if (!session || session.expiresAt <= new Date()) throw new AppError(401, 'UNAUTHENTICATED');
  return session;
}
export async function createSession(r: Resources, config: Config, userId: string, res: Response) {
  const token = randomBytes(32).toString('hex');
  const maxAge = config.SESSION_DAYS * 86400;
  await r.db.session.create({ data: { tokenHash: tokenHash(token), userId, expiresAt: new Date(Date.now() + maxAge * 1000) } });
  res.setHeader('Set-Cookie', serialize('chat_session', token, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge }));
}
export function clearSessionCookie(config: Config, res: Response) {
  res.setHeader('Set-Cookie', serialize('chat_session', '', { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', path: '/', maxAge: 0 }));
}
