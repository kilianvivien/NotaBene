import { expect, test, type Page } from '@playwright/test';
import { openApp } from './app';

/**
 * The graph is a canvas, which a test cannot read. What it can check is the
 * path that makes the canvas reachable without a pointer: open the graph, find
 * a note by title, read its card, open it.
 */
async function openGraph(page: Page) {
  await openApp(page, 'sample');
  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  const graph = page.getByRole('dialog', { name: 'Graph' });
  await expect(graph).toBeVisible();
  return {
    graph,
    find: graph.getByRole('searchbox', { name: 'Find a note' }),
    detail: graph.getByRole('complementary', { name: 'About Start here' }),
  };
}

test('finds a note, shows what the graph knows about it, and opens it', async ({
  page,
}) => {
  const { graph, find, detail } = await openGraph(page);
  await expect(graph.getByRole('img', { name: /Graph of your notes/ })).toBeVisible();

  await find.fill('start');
  await graph
    .getByRole('list', { name: 'Matching notes' })
    .getByRole('button', { name: /Start here/ })
    .click();

  // Picking a note is not opening it: the card comes first.
  await expect(detail.getByRole('heading', { name: 'Start here' })).toBeVisible();
  await expect(detail.getByText('Welcome to NotaBene')).toBeVisible();
  await expect(graph).toBeVisible();

  await detail.getByRole('button', { name: 'Open note' }).click();
  await expect(graph).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Note title' })).toHaveValue(
    'Start here',
  );
});

test('escape backs out one layer at a time', async ({ page }) => {
  const { graph, find, detail } = await openGraph(page);

  await find.fill('zzz');
  await expect(graph.getByText('No note with that title')).toBeVisible();
  await find.fill('start');
  await find.press('Enter');
  await expect(detail).toBeVisible();

  // The find field, then the card, then the graph itself.
  await page.keyboard.press('Escape');
  await expect(find).toHaveValue('');
  await expect(detail).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await expect(graph).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(graph).toBeHidden();
});

test('settings opens above the graph and owns Escape and Tab', async ({ page }) => {
  const { graph, find } = await openGraph(page);
  await find.fill('start');
  const settingsButton = graph.getByRole('button', { name: 'Settings', exact: true });
  await settingsButton.click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  // A real click fails if the graph still covers the modal.
  await settings.getByRole('button', { name: 'Editor', exact: true }).click();
  await page.keyboard.press('Shift+Tab');
  await expect(settings).toContainText('Editor');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(graph).toBeVisible();
  await expect(find).toHaveValue('start');
  await expect(settingsButton).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(find).toHaveValue('');
});
