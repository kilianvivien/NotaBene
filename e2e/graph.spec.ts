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
