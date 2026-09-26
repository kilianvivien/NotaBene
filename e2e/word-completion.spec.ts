import { expect, test, type Page } from '@playwright/test';

/**
 * Word completion with a real keyboard, in a real browser.
 *
 * The unit tests drive the plugin with transactions; this is the path they
 * cannot reach — keystrokes through the DOM, ProseMirror reading them back,
 * the ghost drawn in a real layout, and Tab going to the completer rather
 * than moving focus out of the editor.
 */

async function openCourseNote(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  // The starter course, so the new note belongs to a course and has a
  // vocabulary to complete from.
  await page.getByRole('button', { name: /Welcome to NotaBene/ }).first().click();
  await page.getByRole('button', { name: 'New note' }).click();
  await expect(page.getByRole('textbox', { name: 'Note title' })).toBeVisible();
}

async function addToVocabulary(page: Page, word: string): Promise<void> {
  await page.keyboard.press('Meta+Shift+U');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Add a word or short term' }).fill(word);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.getByText(word, { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(dialog).toBeHidden();
}

test('suggests a course term as ghost text and accepts it with Tab', async ({ page }) => {
  await openCourseNote(page);
  await addToVocabulary(page, 'mitochondrie');

  const body = page.getByLabel('Start typing, or press / for blocks');
  await body.click();
  await page.keyboard.type('La mito', { delay: 40 });

  const ghost = page.locator('.nb-completion-ghost');
  await expect(ghost).toHaveText('chondrie');
  // Drawn inline, straight after the caret, inside the same paragraph.
  await expect(body).toHaveText('La mito' + 'chondrie');
  await expect(body.locator('p')).toHaveCount(1);

  await page.keyboard.press('Tab');
  await expect(ghost).toHaveCount(0);
  await expect(body).toHaveText('La mitochondrie');
  // Tab stayed in the editor: typing carries on where the word ended.
  await page.keyboard.type(' produit');
  await expect(body).toHaveText('La mitochondrie produit');
});

test('Escape dismisses the suggestion and nothing is written', async ({ page }) => {
  await openCourseNote(page);
  await addToVocabulary(page, 'photosynthèse');

  const body = page.getByLabel('Start typing, or press / for blocks');
  await body.click();
  await page.keyboard.type('La photo', { delay: 40 });
  await expect(page.locator('.nb-completion-ghost')).toHaveText('synthèse');

  await page.keyboard.press('Escape');
  await expect(page.locator('.nb-completion-ghost')).toHaveCount(0);
  await expect(body).toHaveText('La photo');
});

test('Tab still indents a list item when nothing is suggested', async ({ page }) => {
  await openCourseNote(page);
  const body = page.getByLabel('Start typing, or press / for blocks');
  await body.click();
  await page.keyboard.type('- first', { delay: 20 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('second', { delay: 20 });
  await expect(page.locator('.nb-completion-ghost')).toHaveCount(0);

  await page.keyboard.press('Tab');
  await expect(body.locator('ul ul li')).toHaveText('second');
});
