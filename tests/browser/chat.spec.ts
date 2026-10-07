import { test, expect } from '@playwright/test';
test('two browsers exchange messages, typing, receipts and files, then search', async ({ browser }) => {
  const adaContext = await browser.newContext();
  const boraContext = await browser.newContext();
  const ada = await adaContext.newPage();
  const bora = await boraContext.newPage();
  try {
    for (const [page, email] of [[ada, 'ada@demo.local'], [bora, 'bora@demo.local']] as const) {
      await page.goto('/');
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill('DemoPassword123!');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByText('Realtime connected', { exact: false })).toBeVisible();
    }
    await ada.getByRole('button', { name: 'Bora direct', exact: true }).click();
    await bora.getByRole('button', { name: 'Ada direct', exact: true }).click();
    const text = `Browser demo ${Date.now()}`;
    await ada.getByLabel('Message', { exact: true }).fill(text);
    await expect(bora.getByText('Ada is typing…')).toBeVisible();
    await ada.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(bora.getByText(text, { exact: true })).toBeVisible();
    await expect(ada.locator('.messages li').filter({ hasText: text }).getByText('Read by Bora')).toBeVisible();
    const fileName = `browser-demo-${Date.now()}.txt`;
    await ada.getByLabel('Attach file', { exact: false }).setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from('Demo file from browser smoke test.') });
    await expect(ada.locator('.composer p').filter({ hasText: fileName })).toBeVisible();
    await ada.getByRole('button', { name: 'Send', exact: true }).click();
    const downloadPromise = bora.waitForEvent('download');
    await bora.getByRole('button', { name: `${fileName} (1 KiB)`, exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(fileName);
    await bora.getByLabel('Search messages', { exact: true }).fill(text);
    await bora.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(bora.locator('.messages li')).toHaveCount(1);
    await bora.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(bora.getByText(text, { exact: true })).toBeVisible();
    await bora.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(bora.getByRole('button', { name: `${fileName} (1 KiB)`, exact: true })).toBeVisible();
    await ada.screenshot({ path: 'test-results/plain-chat.png', fullPage: true });
    await ada.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(ada.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  } finally { await adaContext.close(); await boraContext.close(); }
});
