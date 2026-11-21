import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';

// PEN-174's ac15 on screen: the built site's Usage Data help page and both privacy pages say the
// window's size and layout are recorded; PEN-175's AC11: they list scrolling too; PEN-177's AC24 and AC25: session detail. apps/web's Playwright config runs it as its `site`
// project, so the software factory's web proof (`task proof:web`) can record it; it builds the
// site and serves site/dist itself, on a port the system picks. site.spec.ts checks the same
// words under wrangler dev (`task site:test`), whose config leaves this folder out.

const SITE = fileURLToPath(new URL('../..', import.meta.url));
const DIST = join(SITE, 'dist');

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** site/dist over http, as Cloudflare serves it: a folder's index.html for its path. */
function serve(): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      const path = decodeURIComponent(new URL(request.url ?? '/', 'http://site').pathname);
      let file = normalize(join(DIST, path));
      if (file !== DIST && !file.startsWith(DIST + sep)) {
        response.writeHead(403).end();
        return;
      }
      try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
        const body = await readFile(file);
        response
          .writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
          .end(body);
      } catch {
        response.writeHead(404).end();
      }
    })();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let server: Server;
let base: string;

// One worker runs this file's tests in order: each worker's beforeAll builds the site into one
// site/dist, and two building at once fail on Astro's data store.
test.describe.configure({ mode: 'default' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const built = spawnSync('node', ['build.mjs'], { cwd: SITE, encoding: 'utf8' });
  expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
  server = await serve();
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Brings [words] to the middle of the window and holds there, for the recording. */
async function show(page: Page, words: Locator): Promise<void> {
  await expect(words).toBeVisible();
  await words.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect(words).toBeInViewport();
  await page.waitForTimeout(2_000);
}

test('the Usage Data help page and both privacy pages say the window’s size and layout are recorded (ac15)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });

  // penmoss.app/privacy: what an event carries, the window's size and layout among it.
  await page.goto(`${base}/privacy/`);
  await show(page, page.locator('article').getByText(/window’s size and layout/));

  // The docs' Privacy page.
  await page.goto(`${base}/docs/help/privacy/`);
  await show(
    page,
    page
      .locator('main')
      .getByText(/the window[’']s size and layout/)
      .first(),
  );

  // Usage Data: the sample batch's window event, then the kinds table's App row, held to the end.
  await page.goto(`${base}/docs/help/usage-data/`);
  const main = page.locator('main');
  await show(page, main.getByText('window sizes to the nearest 10 pixels', { exact: false }));
  await show(page, main.locator('code, pre').getByText('"name": "window"').first());
  const app = main.locator('tr').filter({ hasText: /the window[’']s size each time it opens/ });
  await show(page, app);
  await expect(app).toContainText('sidebar, note panel, Full Width, light or dark, how many tabs');
  await expect(app).toBeInViewport();
});

test('the Usage Data help page lists Scroll with an example and the rounding, and both privacy pages name scrolling (PEN-175)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });

  // penmoss.app/privacy and the docs' Privacy page: scrolling among what is recorded.
  await page.goto(`${base}/privacy/`);
  await show(page, page.locator('article').getByText(/how far you\s+scroll/));
  await page.goto(`${base}/docs/help/privacy/`);
  await show(
    page,
    page
      .locator('main')
      .getByText(/how far you scroll/)
      .first(),
  );

  // Usage Data: the rounding and the limits under the table, then the kinds table's Scroll row,
  // held to the end.
  await page.goto(`${base}/docs/help/usage-data/`);
  const main = page.locator('main');
  await show(page, main.getByText('rounded to hundredths', { exact: false }));
  await expect(main.getByText('Keep at Most', { exact: false }).first()).toBeVisible();
  const scroll = main.locator('tr').filter({ hasText: /^\s*Scroll/ });
  await show(page, scroll);
  await expect(scroll).toContainText('0.42 of the way down');
  await expect(scroll).toContainText('folder tree, Recent Notes and Tags');
  await expect(scroll).toContainText('Settings and its list of pages');
  await expect(scroll).toBeInViewport();
});

test('the Usage Data help page lists Note, Input and Tree with examples and the new limits, and both privacy pages describe session detail (PEN-177)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Usage Data (AC24): What is recorded's new rows, the note shape and keyed IDs paragraph,
  // the server's 90 days, then the limits table's Keep at Most.
  await page.goto(`${base}/docs/help/usage-data/`);
  const main = page.locator('main');
  const note = main.locator('tr').filter({ hasText: /^\s*Note\b/ });
  await show(page, note);
  await expect(note).toContainText('h1:12 p:182 li.t.2:31 table.4x3:96 hr');
  for (const [kind, words] of [
    ['Input', 'never the characters themselves'],
    ['Tree', 'to show the open note'],
  ] as const) {
    const row = main.locator('tr').filter({ hasText: new RegExp(`^\\s*${kind}\\b`) });
    await expect(row).toContainText(words);
    await expect(row).toBeInViewport();
  }
  await show(page, main.getByText(/A note and a folder are named by a keyed ID/));
  await expect(main).toContainText('which are exact (never the words)');
  await show(page, main.getByText(/note, input and tree events for 90 days/).first());
  const keep = main.locator('tr').filter({ hasText: 'events.max' });
  await show(page, keep);
  await expect(keep).toContainText('200,000');
  await expect(keep).toContainText('500–2,000,000');

  // penmoss.app/privacy (AC25): the Usage data section's session detail, then its 90 days.
  await page.goto(`${base}/privacy/`);
  const policy = page.locator('article');
  await show(
    page,
    policy.getByText(/the shape of your notes and how much you type, never\s+the words/),
  );
  await expect(policy).toContainText(/at most 200,000\s+events/);
  await show(page, policy.getByText(/note, input and tree events\s+for 90 days/).first());

  // The docs' Privacy and security page: its Usage data section, held to the end.
  await page.goto(`${base}/docs/help/privacy/`);
  const docs = page.locator('main');
  await show(page, docs.getByText(/Inside a note, and the sidebar tree/));
  await expect(docs).toContainText('The words you type are never recorded.');
  const choices = docs.getByText(/a new key for its keyed IDs/);
  await show(page, choices);
  await expect(choices).toBeInViewport();
});
