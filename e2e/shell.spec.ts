import { expect, test } from '@playwright/test';

/**
 * Smoke test for the shell. Runs against `pnpm dev`, which uses the in-memory
 * store — so this covers the create → type → autosave → list-refresh loop
 * without needing a Tauri build.
 */
test('creates a note and reflects its title in the list', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');

  await expect(page.getByRole('button', { name: 'All notes' }).first()).toBeVisible();

  await page.getByRole('button', { name: 'New note' }).click();

  const title = page.getByRole('textbox', { name: 'Note title' });
  await expect(title).toBeVisible();
  await title.fill('Lecture 3 — Limits');

  await page
    .getByLabel('Start typing, or press / for blocks')
    .fill('A limit describes what a function approaches.');

  // Autosave is debounced; the status bar is the signal that it landed.
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  // The list reads from summaries, so this also proves it re-queried.
  await expect(page.getByRole('button', { name: /Lecture 3/ })).toBeVisible();
});

test('creates localized starter material on first run', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start here/ })).toBeVisible();
  await expect(
    page.getByText(
      'Your library stays on this Mac. NotaBene has no account, cloud sync, or telemetry.',
      { exact: true },
    ),
  ).toBeVisible();
});

test('builds a real PDF in the browser export path', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await page.keyboard.press('Meta+Shift+E');
  await expect(page.getByRole('dialog', { name: 'Export notes' })).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await download;
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe('%PDF-');
});
