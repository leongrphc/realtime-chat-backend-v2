import { spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
loadEnvFile('.env');
const database = process.env.TEST_DATABASE_URL;
const redis = process.env.TEST_REDIS_URL;
if (!database || !redis || database === process.env.DATABASE_URL || redis === process.env.REDIS_URL) throw new Error('Separate TEST_DATABASE_URL and TEST_REDIS_URL are required.');
const parsed = new URL(database);
if (!parsed.pathname.endsWith('_test')) throw new Error('Test database name must end in _test.');
const redisDb = new URL(redis).pathname;
if (!/^\/[1-9]\d*$/.test(redisDb)) throw new Error('Test Redis must use a nonzero logical database.');
const env = { ...process.env, DATABASE_URL: database, REDIS_URL: redis, S3_BUCKET: `${process.env.S3_BUCKET}-test` };
for (const args of [['prisma', 'migrate', 'deploy'], ['vitest', 'run', '--config', 'vitest.integration.config.mts']]) {
  const result = spawnSync('npx', args, { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
