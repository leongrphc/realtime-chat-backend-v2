import { PrismaClient } from '@prisma/client';
import { createClient } from 'redis';
import { S3Client } from '@aws-sdk/client-s3';
import type { Config } from './config';
import { AppError } from './core';
export function resources(config: Config) {
  const db = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  const redis = createClient({ url: config.REDIS_URL });
  redis.on('error', () => console.error('Redis connection error'));
  const opts = { region: config.S3_REGION, forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: config.S3_ACCESS_KEY && config.S3_SECRET_KEY ? { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY } : undefined };
  const s3 = new S3Client({ ...opts, endpoint: config.S3_ENDPOINT });
  const downloadS3 = new S3Client({ ...opts, endpoint: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT });
  return { db, redis, s3, downloadS3 };
}
export type Resources = ReturnType<typeof resources>;
const limitScript = `local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; return n`;
export async function rateLimit(r: Resources, key: string, max: number, windowMs = 60000) {
  const count = Number(await r.redis.eval(limitScript, { keys: [`limit:${key}`], arguments: [String(windowMs)] }));
  if (count > max) throw new AppError(429, 'RATE_LIMITED');
}
export async function presence(r: Resources, userId: string) {
  const key = `presence:${userId}`;
  await r.redis.zRemRangeByScore(key, '-inf', Date.now());
  return (await r.redis.zCard(key)) > 0;
}
export async function touchPresence(r: Resources, userId: string, socketId: string) {
  await r.redis.multi().zAdd(`presence:${userId}`, { score: Date.now() + 45000, value: socketId })
    .expire(`presence:${userId}`, 90).exec();
}
