import { expect, type Page } from '@playwright/test';

type Start = 'sample' | 'empty' | 'import';

const ACTIONS: Record<Start, string> = {
  sample: 'Explore a sample course',
  empty: 'Start with an empty library',
  import: 'Bring my notes',
};

/**
 * Open a fresh profile and answer the welcome screen. Every test starts on an
 * empty in-memory library, so it is always shown; the default is the sample
 * course the specs were written against.
 */
export async function openApp(page: Page, start: Start = 'sample'): Promise<void> {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  const welcome = page.getByRole('dialog', { name: 'Welcome to NotaBene' });
  await expect(welcome).toBeVisible();
  await welcome.getByRole('button', { name: ACTIONS[start], exact: true }).click();
  await expect(welcome).toBeHidden();
}
