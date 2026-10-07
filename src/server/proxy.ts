import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from './config';

export function trustedEdge(req: IncomingMessage, config: Config): boolean {
  if (!config.EDGE_PROXY_SECRET) return false;
  const supplied = req.headers['x-chat-proxy-secret'];
  if (typeof supplied !== 'string') return false;
  const expected = Buffer.from(config.EDGE_PROXY_SECRET);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function clientAddress(req: IncomingMessage, config: Config): string {
  const forwarded = req.headers['x-chat-client-ip'];
  return trustedEdge(req, config) && typeof forwarded === 'string'
    ? forwarded : req.socket.remoteAddress ?? 'unknown';
}
