import { spawnSync } from 'node:child_process';
if (!process.env.DIRECT_DATABASE_URL) throw new Error('DIRECT_DATABASE_URL is required for production migrations');
const result = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: process.env.DIRECT_DATABASE_URL }
});
process.exit(result.status ?? 1);
