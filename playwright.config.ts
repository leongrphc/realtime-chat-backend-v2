import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', workers: 1, fullyParallel: false,
  timeout: 30000, expect: { timeout: 10000 },
  use: { baseURL: 'http://localhost:3000', browserName: 'chromium', headless: true, trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run start:api', url: 'http://localhost:4000/health/ready', reuseExistingServer: !process.env.CI, timeout: 60000 },
    { command: 'npm run start:web', url: 'http://localhost:3000', reuseExistingServer: !process.env.CI, timeout: 60000 }
  ]
});
