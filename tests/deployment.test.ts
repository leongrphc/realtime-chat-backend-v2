import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { readConfig } from '../src/server/config';
import { clientAddress, trustedEdge } from '../src/server/proxy';

const environment: NodeJS.ProcessEnv = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/chat', REDIS_URL: 'redis://localhost:6379',
  WEB_ORIGIN: 'https://chat.example.com', UPLOADS_ENABLED: 'false', EDGE_PROXY_SECRET: 'a'.repeat(64) };
describe('production deployment boundaries', () => {
  it('starts without storage credentials only when uploads are disabled', () => {
    expect(readConfig(environment).UPLOADS_ENABLED).toBe(false);
    expect(() => readConfig({ ...environment, UPLOADS_ENABLED: 'true' })).toThrow();
    expect(readConfig({ ...environment, PORT: '10000', API_PORT: '4000' }).API_PORT).toBe(10000);
  });
  it('only trusts client IP headers authenticated by the edge secret', () => {
    const config = readConfig(environment);
    const request = { headers: { 'x-chat-client-ip': '203.0.113.1' }, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
    expect(trustedEdge(request, config)).toBe(false);
    expect(clientAddress(request, config)).toBe('127.0.0.1');
    request.headers['x-chat-proxy-secret'] = 'wrong';
    expect(trustedEdge(request, config)).toBe(false);
    request.headers['x-chat-proxy-secret'] = environment.EDGE_PROXY_SECRET;
    expect(trustedEdge(request, config)).toBe(true);
    expect(clientAddress(request, config)).toBe('203.0.113.1');
  });
});
