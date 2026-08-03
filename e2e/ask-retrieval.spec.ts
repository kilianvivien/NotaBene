import { expect, test, type Page } from '@playwright/test';

/**
 * The whole wide-scope Ask path, in a browser, against a stubbed provider.
 *
 * `pnpm dev` runs the in-memory store and the `fetch` transport, so the only
 * thing standing between this test and the real feature is the model itself —
 * which is replaced by a route handler that records what it was sent. That
 * recording is the point: asserting the *retrieved* note's text reached the
 * prompt is the only way to prove retrieval worked, rather than that the panel
 * merely rendered something.
 */

/** One OpenAI-shaped SSE stream. Ollama speaks this dialect. */
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

const ANSWER = 'An eigenvector keeps its direction under the transformation.';

/** Capture every prompt the panel sends, and answer with a fixed sentence. */
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
  await page.getByRole('button', { name: /Ollama/ }).first().click();
  await page.getByRole('checkbox', { name: 'Use this local runtime' }).check();
  await page.getByRole('button', { name: 'Close' }).click();
}

async function createNote(page: Page, title: string, body: string) {
  await page.getByRole('button', { name: 'New note' }).click();
  await page.getByRole('textbox', { name: 'Note title' }).fill(title);
  await page.getByLabel('Start typing, or press / for blocks').fill(body);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({
    timeout: 5_000,
  });
}

/** The scope control is a pop-up button: open it, then pick a row. */
async function chooseScope(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('menuitemradio', { name }).click();
}

async function ask(page: Page, question: string) {
  const composer = page.getByRole('textbox', { name: 'Ask' });
  await expect(composer).toBeEnabled();
  await composer.fill(question);
  await page.getByRole('button', { name: 'Send' }).click();
}

test('answers from a note the question never names, and cites it', async ({ page }) => {
  const stub = await stubProvider(page);

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await enableStubbedProvider(page);

  // The note that holds the answer, in the lecturer's words.
  await createNote(
    page,
    'Lecture 4 — Eigenvectors',
    'A vector that the matrix does not rotate is called an eigenvector.',
  );
  // A decoy, so a passing test cannot just be "everything was sent".
  await createNote(page, 'Chemistry — Titration', 'Titration finds an unknown pH.');
  // The note the student is looking at, which says nothing useful.
  await createNote(page, 'Course outline', 'Week by week plan.');

  await page.getByRole('button', { name: 'Show inspector' }).click();
  await page.getByRole('radio', { name: 'Ask', exact: true }).click();
  await chooseScope(page, 'All notes');

  // Phrased the way a student remembers it, sharing no distinctive word with
  // the note that answers it.
  await ask(page, 'which vector keeps pointing the same way?');

  await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 10_000 });

  // The retrieved note's own text must have reached the prompt.
  expect(stub.prompts).toHaveLength(1);
  expect(stub.prompts[0]).toContain('does not rotate is called an eigenvector');
  expect(stub.prompts[0]).toContain('Course outline');
  // …and the decoy must not have.
  expect(stub.prompts[0]).not.toContain('Titration finds an unknown');

  // The wide-scope hedge travels with it, or a miss reads as an absence.
  expect(stub.prompts[0]).toContain('the ones a keyword search found');

  const sources = page.getByRole('button', { name: /Lecture 4/ });
  await expect(sources.last()).toBeVisible();
});

test('a citation opens the note it names', async ({ page }) => {
  await stubProvider(page);

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await enableStubbedProvider(page);

  await createNote(
    page,
    'Lecture 4 — Eigenvectors',
    'A vector that the matrix does not rotate is called an eigenvector.',
  );
  await createNote(page, 'Course outline', 'Week by week plan.');

  await page.getByRole('button', { name: 'Show inspector' }).click();
  await page.getByRole('radio', { name: 'Ask', exact: true }).click();
  await chooseScope(page, 'All notes');
  await ask(page, 'which vector keeps pointing the same way?');
  await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 10_000 });

  await expect(page.getByRole('textbox', { name: 'Note title' })).toHaveValue(
    'Course outline',
  );

  // The citation chip lives in the inspector, after the answer.
  await page
    .locator('aside')
    .getByRole('button', { name: /Lecture 4/ })
    .click();

  await expect(page.getByRole('textbox', { name: 'Note title' })).toHaveValue(
    'Lecture 4 — Eigenvectors',
  );
});

test('sends only the open note, and no hedge, at note scope', async ({ page }) => {
  const stub = await stubProvider(page);

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await enableStubbedProvider(page);

  await createNote(
    page,
    'Lecture 4 — Eigenvectors',
    'A vector that the matrix does not rotate is called an eigenvector.',
  );
  await createNote(page, 'Course outline', 'Week by week plan.');

  await page.getByRole('button', { name: 'Show inspector' }).click();
  await page.getByRole('radio', { name: 'Ask', exact: true }).click();
  await ask(page, 'which vector keeps pointing the same way?');
  await expect(page.getByText(ANSWER)).toBeVisible({ timeout: 10_000 });

  // The regression that matters most: the default scope still sends one note.
  expect(stub.prompts[0]).toContain('Week by week plan');
  expect(stub.prompts[0]).not.toContain('does not rotate is called an eigenvector');
  expect(stub.prompts[0]).not.toContain('the ones a keyword search found');

  // And nothing to cite, so no sources row.
  await expect(page.locator('aside').getByText('Sources')).toHaveCount(0);
});
