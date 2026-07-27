import { expect, test } from '@playwright/test';

/**
 * Smoke test for the shell. Runs against `pnpm dev`, which uses the in-memory
 * store — so this covers the create → type → autosave → list-refresh loop
 * without needing a Tauri build.
 */
test('creates a note and reflects its title in the list', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('button', { name: 'All notes' }).first()).toBeVisible();

  await page.getByRole('button', { name: 'New note' }).click();

  const title = page.getByRole('textbox', { name: 'Note title' });
  await expect(title).toBeVisible();
  await title.fill('Lecture 3 — Limits');

  await page
    .getByRole('textbox', { name: 'Start typing, or press / for blocks' })
    .fill('A limit describes what a function approaches.');

  // Autosave is debounced; the status bar is the signal that it landed.
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

  // The list reads from summaries, so this also proves it re-queried.
  await expect(page.getByRole('button', { name: /Lecture 3/ })).toBeVisible();
});

test('shows the empty state before anything exists', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('No notes here yet')).toBeVisible();
});
