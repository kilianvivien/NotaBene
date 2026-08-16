import { chromium } from '@playwright/test';
const OUT = '/tmp/claude-0/-home-user-NotaBene/3c7dd3fc-b809-50fb-bce3-554186a02b5f/scratchpad/shots';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await b.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 140)); });
await page.goto('http://localhost:5173/');
await page.waitForSelector('[data-ready="true"]', { timeout: 30000 });
await page.waitForTimeout(600);

await page.getByRole('option', { name: /Start here/i }).first().click();
await page.waitForTimeout(600);
await page.keyboard.press('Control+Alt+KeyI');
await page.waitForTimeout(500);
await page.getByRole('radio', { name: 'Links' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/L1-links-tab.png` });
console.log('captured links tab');

await page.getByRole('button', { name: 'Save a web page' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/L2-add-link-dialog.png` });
console.log('captured dialog');

// The guard, seen from the UI: loopback is where NotaBene's own MCP server is.
await page.getByRole('dialog').locator('input[type="url"]').fill('http://127.0.0.1:22600/mcp');
await page.getByRole('dialog').getByRole('button', { name: 'Save a web page' }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/L3-refused-host.png` });
console.log('captured refusal');

await b.close();
