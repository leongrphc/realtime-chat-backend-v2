import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const result = spawnSync(process.execPath, ['node_modules/next/dist/bin/next', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, STATIC_EXPORT: 'true', NEXT_PUBLIC_API_URL: 'https://chat.mozkan.com.tr',
    NEXT_PUBLIC_UPLOADS_ENABLED: 'false', NEXT_PUBLIC_DEMO_MODE: 'false', NEXT_TELEMETRY_DISABLED: '1' }
});
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync('out', { recursive: true });
writeFileSync('out/_headers', '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n  X-Frame-Options: DENY\n');
