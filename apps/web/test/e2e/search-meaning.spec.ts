import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, seeded, test, type Page } from './fixtures';
import { MEANING_NOT_READY } from '../../src/search/meaning';
import { CONCEPTS } from './support/meaning-host';

// T77 (A1155, A1156): the Mac app's search box finds by meaning. The stand-in Mac runs the app's
// own embedding service (MeaningService) with a concept embedder (support/meaning-host.ts): the
// page feeds it the notebook's notes and fuses its hits with the words'. The words answer at
// once; the hybrid answer replaces them after a pause or on Enter. A note found by meaning alone
// shows ≈ and opens at its heading. The real model is the Electron suite's (T76).

test.use({
  meaning: true,
  seed: {
    name: 'Notes',
    notes: [
      {
        title: 'Server room',
        markdown:
          '## Racks\n\nTwo racks by the door.\n\n## Power\n\nThe UPS battery holds for twenty minutes.',
      },
      { title: 'Sourdough', markdown: 'Feed the starter, knead the dough, bake the loaf.' },
      { title: 'Japan trip', markdown: 'Shrines in Kyoto, and the rail pass.' },
      { title: 'Taxes', markdown: 'The receipts are in the blue folder.' },
    ],
  },
});

const SEARCH = 'ControlOrMeta+Shift+KeyF';
/** Screenshots: docs/evidence/192/t77/web when EVIDENCE_DIR names it, else the test's output. */
const EVIDENCE_DIR = process.env['EVIDENCE_DIR'];

const overlay = (page: Page) => page.getByTestId('search');
const input = (page: Page) => overlay(page).getByRole('combobox', { name: 'Search notes' });
const results = (page: Page) =>
  overlay(page).getByRole('listbox', { name: 'Search results' }).getByRole('option');
const titles = (page: Page) =>
  results(page).evaluateAll((nodes) =>
    nodes.map((node) => node.querySelector('.search-hit-title')?.textContent ?? ''),
  );

/** Opens search once the app is up (its commands are registered). */
async function openSearch(page: Page): Promise<void> {
  await expect(page.locator('button[data-command="note.new"]').first()).toBeAttached({
    timeout: 30_000,
  });
  await page.keyboard.press(SEARCH);
  await expect(input(page)).toBeFocused();
  // The service has every note's vectors (before that, results say how many it covers).
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const status = await window.penmossDesktop?.meaning?.status();
          return status ? `${status.indexed}/${status.total}` : null;
        }),
      { timeout: 30_000 },
    )
    .toBe('4/4');
  // The seeded notes have reached this device: words find each of them.
  await expect(async () => {
    await input(page).fill('');
    await input(page).fill('taxes');
    await expect(results(page).filter({ hasText: 'Taxes' })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function shoot(page: Page, name: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await overlay(page).screenshot({
      path: join(dir, `${name}-${scheme}.png`),
      animations: 'disabled',
    });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('a concept finds its note by meaning, marked ≈, and opens at its heading', async ({
  page,
  notebook,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(CONCEPTS['blackout']).toBe(CONCEPTS['battery']);
  const errors = collectErrors(page);
  await page.goto('/');
  await openSearch(page);
  await input(page).fill('sourdough');
  await expect.poll(() => titles(page)).toContain('Sourdough');

  // No word of this is in the note: meaning alone finds it, once the service has its vectors.
  await input(page).fill('blackout');
  const found = results(page).filter({ hasText: 'Server room' });
  await expect(found).toBeVisible({ timeout: 30_000 });
  await expect(found).toHaveAttribute('data-sources', 'semantic');
  await expect(found.locator('.search-source')).toHaveText('≈');
  await expect(found.locator('.search-source')).toHaveAttribute('title', 'Found by meaning');
  await expect(found.locator('.search-heading')).toHaveText('› Power');
  await expect(found).toContainText('UPS battery');
  // Unrelated notes stay out: below the floor.
  expect(await titles(page)).not.toContain('Taxes');
  await expect(overlay(page).getByTestId('search-words-only')).toHaveCount(0);
  await expect(overlay(page).getByTestId('search-notice')).toHaveCount(0);
  await shoot(page, 'meaning-hit', EVIDENCE_DIR ?? testInfo.outputPath('evidence'));

  // Found by words too: no ≈, and it ranks with the words.
  await input(page).fill('battery');
  const both = results(page).filter({ hasText: 'Server room' });
  await expect(both).toHaveAttribute('data-sources', 'full-text semantic', { timeout: 10_000 });
  await expect(both.locator('.search-source')).toHaveCount(0);

  // Typing: the words at once (nothing has "temple"), then meaning's answer; Enter opens the
  // active row at its heading.
  await input(page).fill('temples and trains');
  await expect(results(page).first()).toContainText('Japan trip', { timeout: 10_000 });
  await page.keyboard.press('Enter');
  await expect(overlay(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/notes/${seeded(notebook).noteIds[2]}$`));

  // Enter before the pause answers by meaning at once.
  await page.keyboard.press(SEARCH);
  await input(page).fill('');
  await page.keyboard.type('outage');
  await page.keyboard.press('Enter');
  await expect(results(page).first()).toContainText('Server room');
  // It opens at the section meaning matched.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(
    new RegExp(`/notes/${seeded(notebook).noteIds[0]}\\?heading=Power$`),
  );
  expect(errors).toEqual([]);
});

test('an edit reaches meaning a moment after it settles', async ({ page, notebook }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await openSearch(page);
  await page.keyboard.press('Escape');
  // Taxes has nothing of power cuts: then a generator is added to it.
  await page.goto(`/notes/${seeded(notebook).noteIds[3]}`);
  const body = page.locator('.ProseMirror').first();
  await body.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' A generator stands behind the shed.');
  await page.keyboard.press('ControlOrMeta+Shift+KeyF');
  await expect(async () => {
    await input(page).fill('');
    await input(page).fill('blackout');
    await expect(results(page).filter({ hasText: 'Taxes' })).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('with Search by Meaning off, the Mac says Words only and why', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await openSearch(page);
  // Off, as Settings does it: the model and the vectors go, and the page hears so.
  await page.evaluate(() => window.penmossDesktop?.meaning?.setEnabled(false));
  await input(page).fill('');
  await input(page).fill('blackout');
  await expect(overlay(page).getByTestId('search-words-only')).toHaveAttribute(
    'data-tip',
    MEANING_NOT_READY.wordsOnly,
    { timeout: 10_000 },
  );
  // No word of "blackout" is in any note, and meaning is off: nothing.
  await page.waitForTimeout(1_000);
  expect(await titles(page)).toEqual([]);
  // Words still answer.
  await input(page).fill('sourdough');
  await expect(results(page).filter({ hasText: 'Sourdough' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a narrow window shows the same', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/');
  await openSearch(page);
  await input(page).fill('baking bread');
  await expect(results(page).filter({ hasText: 'Sourdough' })).toBeVisible({ timeout: 30_000 });
  await shoot(page, 'meaning-narrow', EVIDENCE_DIR ?? testInfo.outputPath('evidence'));
});
