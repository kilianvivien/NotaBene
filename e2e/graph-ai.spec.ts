import { expect, test, type Page } from '@playwright/test';
import { openApp } from './app';

/**
 * The graph's three hand-offs to AI features, against a stubbed provider.
 *
 * None of them runs in the graph: each leaves it for the surface that owns
 * the feature, carrying the graph's selection. So what is checked is the
 * hand-over — the right notes arrive — and, for Ask, that a note reached the
 * prompt *because it is linked*, sharing no word with the question.
 */
function sseBody(text: string): string {
  const frames = text
    .split(' ')
    .map(
      (word, index) =>
        `data: ${JSON.stringify({
          choices: [{ delta: { content: index ? ` ${word}` : word } }],
        })}\n\n`,
    )
    .join('');
  return `${frames}data: [DONE]\n\n`;
}

const ANSWER = 'Friction takes the energy out.';

async function stubProvider(page: Page): Promise<{ prompts: string[] }> {
  const prompts: string[] = [];
  await page.route('**/chat/completions', async (route) => {
    prompts.push(route.request().postData() ?? '');
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: sseBody(ANSWER),
    });
  });
  return { prompts };
}

/** Ollama needs no key — just the local-runtime switch. */
async function enableStubbedProvider(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'AI providers' }).click();
  await page
    .getByRole('button', { name: /Ollama/ })
    .first()
    .click();
  await page.getByRole('checkbox', { name: 'Use this local runtime' }).check();
  await page.getByRole('button', { name: 'Close' }).click();
}

/**
 * Three notes through the command layer: one that links to another, and one
 * that only names it. Typing a wiki link through the editor is the editor's
 * test to make; this one needs the links to exist.
 */
async function seedLinkedNotes(page: Page) {
  await page.evaluate(async () => {
    const path = '/src/lib/commands/index.ts';
    const commands = await import(/* @vite-ignore */ path);
    const text = (value: string) => ({ type: 'text', text: value });
    const paragraph = (...content: unknown[]) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content }],
    });
    const damping = await commands.createNoteCommand({
      title: 'Damping',
      doc: paragraph(text('The dashpot bleeds the oscillator dry.')),
    });
    await commands.createNoteCommand({
      title: 'Week 4',
      doc: paragraph(text('Today: '), {
        type: 'wikiLink',
        attrs: { noteId: damping.value.id, title: 'Damping' },
      }),
    });
    await commands.createNoteCommand({
      title: 'Week 5',
      doc: paragraph(text('We came back to damping briefly.')),
    });
  });
}

async function openGraphOn(page: Page, title: string) {
  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  const graph = page.getByRole('dialog', { name: 'Graph' });
  await graph.getByRole('searchbox', { name: 'Find a note' }).fill(title);
  await graph
    .getByRole('list', { name: 'Matching notes' })
    .getByRole('button', { name: new RegExp(title) })
    .click();
  const detail = graph.getByRole('complementary', { name: `About ${title}` });
  await expect(detail).toBeVisible();
  return { graph, detail };
}

test('offers no AI in the graph until a provider is set up', async ({ page }) => {
  await openApp(page, 'empty');
  await seedLinkedNotes(page);
  const { graph, detail } = await openGraphOn(page, 'Week 4');

  await expect(detail.getByRole('button', { name: 'Open note' })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Synthesise' })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Ask' })).toHaveCount(0);
  await graph.getByRole('button', { name: 'Mentions' }).click();
  await expect(graph.getByText(/1 mention/)).toBeVisible();
  await expect(graph.getByRole('button', { name: /with the agent/ })).toHaveCount(0);
});

test('asks about a note and its links, and the linked note reaches the prompt', async ({
  page,
}) => {
  const stub = await stubProvider(page);
  await openApp(page, 'empty');
  await enableStubbedProvider(page);
  await seedLinkedNotes(page);

  const { graph, detail } = await openGraphOn(page, 'Week 4');
  await expect(detail.getByText('With its 1 linked note')).toBeVisible();
  await detail.getByRole('button', { name: 'Ask' }).click();

  // The graph gives way to the note and its Ask panel, already scoped.
  await expect(graph).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Note title' })).toHaveValue('Week 4');
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toHaveAttribute(
    'title',
    'Search · This note and its links',
  );

  const composer = page.getByRole('textbox', { name: 'Ask' });
  await composer.fill('where does the energy go?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 10_000 });

  // Linked, so sent — though it shares no word with the question…
  expect(stub.prompts).toHaveLength(1);
  expect(stub.prompts[0]).toContain('dashpot bleeds the oscillator dry');
  // …and the note that merely names Damping, linked to nothing, was not.
  expect(stub.prompts[0]).not.toContain('came back to damping briefly');
  expect(stub.prompts[0]).toContain('the notes it is linked to or from');
});

test('hands a note and its links to Synthesis', async ({ page }) => {
  await stubProvider(page);
  await openApp(page, 'empty');
  await enableStubbedProvider(page);
  await seedLinkedNotes(page);

  const { graph, detail } = await openGraphOn(page, 'Damping');
  await detail.getByRole('button', { name: 'Synthesise' }).click();

  await expect(graph).toBeHidden();
  const dialog = page.getByRole('dialog', { name: 'Summarize' });
  await expect(dialog).toBeVisible();
  // Both notes, by title — neither needs to be in the list behind the dialog.
  await expect(dialog.getByText('Damping', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Week 4', { exact: true })).toBeVisible();
});

test('writes the agent a task for the mentions on screen, and starts nothing', async ({
  page,
}) => {
  const stub = await stubProvider(page);
  await openApp(page, 'empty');
  await enableStubbedProvider(page);
  await seedLinkedNotes(page);

  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  const graph = page.getByRole('dialog', { name: 'Graph' });
  await graph.getByRole('button', { name: 'Mentions' }).click();
  await graph.getByRole('button', { name: /with the agent/ }).click();

  await expect(graph).toBeHidden();
  await expect(page.locator('aside textarea')).toHaveValue(
    'Find the unlinked mentions in my notes and turn them into links.',
  );
  // A drafted task is not a run: the model has not been called.
  expect(stub.prompts).toHaveLength(0);
});
