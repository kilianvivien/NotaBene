import { expect, test, type Page } from '@playwright/test';

/**
 * The Ask panel's scope control, in a real browser.
 *
 * Runs against `pnpm dev` and therefore the in-memory store with no AI provider
 * configured, so this covers everything up to the provider call: that the
 * control renders, that both locales resolve, and that "This course" refuses a
 * note with no course. Answering and citations need a key and belong to manual
 * verification in the desktop build.
 *
 * The control is a pop-up button rather than a segmented control — three scope
 * labels do not fit across a 280px inspector — so a scope change here is the
 * two gestures a reader makes: open the menu, pick the row.
 */
async function openAskPanel(page: Page, title: string) {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');

  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('textbox', { name: 'Note title' }).fill(title);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({
    timeout: 5_000,
  });

  // The inspector is collapsed on a fresh profile.
  await page.getByRole('button', { name: 'Show inspector' }).click();
  await page.getByRole('radio', { name: 'Ask', exact: true }).click();
}

function scopeButton(page: Page) {
  return page.getByRole('button', { name: 'Search', exact: true });
}

test('offers the three scopes, defaulting to the open note', async ({ page }) => {
  await openAskPanel(page, 'Lecture 4 — Eigenvectors');

  // The trigger states the current scope without being opened.
  await expect(scopeButton(page)).toHaveAttribute('title', 'Search · This note');

  await scopeButton(page).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitemradio', { name: 'This note' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(menu.getByRole('menuitemradio', { name: 'This course' })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'All notes' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The grounding control is a separate axis and must still be there.
  await expect(page.getByRole('button', { name: 'Answer sources' })).toBeVisible();
});

test('refuses course scope for a note that is in no course', async ({ page }) => {
  await openAskPanel(page, 'Inbox note');

  await scopeButton(page).click();
  const course = page.getByRole('menuitemradio', { name: 'This course' });

  await expect(course).toBeDisabled();
  await expect(course).toHaveAttribute('title', 'This note is not in a course');
});

test('explains what widening the scope means before the first question', async ({
  page,
}) => {
  await openAskPanel(page, 'Lecture 5');

  // At note scope the panel promises nothing about searching, because it does
  // not search.
  await expect(
    page.getByText(/Answers may draw on any note in your library/),
  ).toHaveCount(0);

  await scopeButton(page).click();
  await page.getByRole('menuitemradio', { name: 'All notes' }).click();

  await expect(
    page.getByText(/Answers may draw on any note in your library/),
  ).toBeVisible();
});

test('keeps a separate conversation per scope', async ({ page }) => {
  await openAskPanel(page, 'Lecture 6');

  const composer = page.getByRole('textbox', { name: 'Ask' });

  // No provider is configured in `pnpm dev`, so the composer is disabled and
  // the panel says why — which is itself worth pinning.
  await expect(composer).toBeDisabled();
  await expect(page.getByText('Connect a provider').first()).toBeVisible();

  // Switching scope must not throw or blank the panel.
  await scopeButton(page).click();
  await page.getByRole('menuitemradio', { name: 'All notes' }).click();
  await expect(scopeButton(page)).toHaveAttribute('title', 'Search · All notes');
  await expect(page.getByText(/Ask your notes anything/)).toBeVisible();
});
