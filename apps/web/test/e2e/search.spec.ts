import { expect, type Page, test } from './fixtures';
import { storedRecord } from './stored';
import { MEANING_ELSEWHERE } from '../../src/search/meaning';
import { collectErrors, newNote, ULID } from './support/app';
import { notebookAction } from './notebook-actions';

// T22 on a git notebook (T59): search from the shortcut and the palette, highlighted snippets,
// the tag filter, all from this device's index of the notebook (A826), the same offline. This
// stand-in Mac has no search by meaning (search-meaning.spec.ts has it): results match words
// and say Words only (A1156).

// Ends in digits, which the porter stemmer leaves alone, so prefixes of it stay prefixes.
const RUN = `${Date.now().toString(36)}${100 + Math.floor(Math.random() * 900)}`;
const SEARCH = 'ControlOrMeta+Shift+KeyF';

/**
 * This device's index reads the notes as stored (A7): it holds a note's words once its record
 * has them (the server's index answered before, T59).
 */
async function stored(page: Page, id: string, words: string): Promise<void> {
  await expect.poll(async () => (await storedRecord(page, id))?.text ?? '').toContain(words);
}

const overlay = (page: Page) => page.getByTestId('search');
const input = (page: Page) => overlay(page).getByRole('combobox', { name: 'Search notes' });
const results = (page: Page) =>
  overlay(page).getByRole('listbox', { name: 'Search results' }).getByRole('option');
const resultIds = (page: Page) =>
  results(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-note-id')));
test('searches every note online and offline, with highlights, filters and modes', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page, /ERR_INTERNET_DISCONNECTED|WebSocket|Failed to fetch|net::/);
  const word = `kelp${RUN}`;
  await page.goto('/');
  const mirror = await newNote(
    page,
    `Git mirror ${word}`,
    `Every night the ${word} vault is pushed to a private repository #lab${RUN}`,
  );
  const tide = await newNote(page, `Tide tables ${RUN}`, `The ${word} harvest follows the tide.`);
  await stored(page, mirror, 'private repository');
  await stored(page, tide, 'follows the tide.');

  // The shortcut opens search; the title outweighs the body (bm25 with column weights).
  await page.keyboard.press(SEARCH);
  await expect(input(page)).toBeFocused();
  await input(page).fill(word);
  await expect.poll(() => resultIds(page)).toEqual([mirror, tide]);
  await expect(results(page).first().locator('mark').first()).toHaveText(word);
  await expect(overlay(page).getByTestId('search-status')).toContainText(
    /^\d+ results on this device/,
  );

  // As you type, the last word is a prefix; a phrase must match as written.
  await input(page).fill(word.slice(0, -1));
  await expect.poll(() => resultIds(page)).toEqual([mirror, tide]);
  await input(page).fill(`"${word} harvest"`);
  await expect.poll(() => resultIds(page)).toEqual([tide]);

  // The tag filter keeps notes with the tag (or one nested under it).
  await input(page).fill(word);
  await overlay(page).getByRole('combobox', { name: 'Tag' }).selectOption(`lab${RUN}`);
  await expect.poll(() => resultIds(page)).toEqual([mirror]);
  await overlay(page).getByRole('combobox', { name: 'Tag' }).selectOption('');
  await expect.poll(() => resultIds(page)).toEqual([mirror, tide]);

  // One search, with no type picker (T42, A571). Without search by meaning, Words only says so
  // quietly, with why in its tooltip, and there is no notice (A1156).
  await expect(overlay(page).getByRole('radiogroup')).toHaveCount(0);
  await expect(overlay(page).getByRole('radio')).toHaveCount(0);
  await expect(overlay(page).getByTestId('search-words-only')).toHaveAttribute(
    'data-tip',
    MEANING_ELSEWHERE.wordsOnly,
  );
  await expect(overlay(page).getByTestId('search-notice')).toHaveCount(0);
  await expect(overlay(page).getByRole('listbox', { name: 'Search results' })).toHaveAttribute(
    'aria-busy',
    'false',
  );

  // Enter opens the active result; Esc closed nothing else on the way.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/notes/${tide}$`));
  await expect(overlay(page)).toHaveCount(0);

  // The palette lists the command too.
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.getByTestId('palette').getByRole('combobox').fill('Search notes');
  await page.keyboard.press('Enter');
  await expect(input(page)).toBeFocused();

  // Offline: the same top results from this device's index, said so, never as a failure.
  await context.setOffline(true);
  await input(page).fill(word);
  await expect.poll(() => resultIds(page)).toEqual([mirror, tide]);
  await expect(overlay(page).getByTestId('search-status')).toContainText('on this device');
  await expect(overlay(page).getByTestId('search-words-only')).toBeVisible();
  await expect(overlay(page).getByTestId('search-notice')).toHaveCount(0);
  await context.setOffline(false);

  await page.keyboard.press('Escape');
  await expect(overlay(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

// #120 (A680): a word typed past its stem (`…conditio` of `…conditioning`, stemmed `…condit`)
// finds the note at once from this device's index, online and offline.
test('finds a word typed past its stem, online and offline', async ({ page, context }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page, /ERR_INTERNET_DISCONNECTED|WebSocket|Failed to fetch|net::/);
  // The run's suffix leads, so porter still cuts each word's ending.
  const conditioning = `${RUN}conditioning`;
  const generations = `${RUN}generations`;
  await page.goto('/');
  const note = await newNote(
    page,
    `Training ${RUN}`,
    `${conditioning} drills for three ${generations} of runners`,
  );
  await stored(page, note, 'of runners');
  await page.keyboard.press(SEARCH);
  await expect(input(page)).toBeFocused();
  await input(page).fill(conditioning.slice(0, -3));
  await expect.poll(() => resultIds(page)).toEqual([note]);
  await expect(results(page).first().locator('mark').first()).toHaveText(conditioning);

  await context.setOffline(true);
  await input(page).fill(generations.slice(0, -3));
  await expect.poll(() => resultIds(page)).toEqual([note]);
  await expect(overlay(page).getByTestId('search-status')).toContainText('on this device');
  await expect(results(page).first().locator('mark').first()).toHaveText(generations);
  await context.setOffline(false);

  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

const SHOTS = process.env['PENMOSS_EVIDENCE'];

const LONG = Array.from({ length: 80 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n\n');

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

async function openNote(page: Page, title: string, notebook = 'Quanta'): Promise<void> {
  await section(page, notebook)
    .getByRole('tree', { name: 'Folders and notes' })
    .getByRole('link', { name: title, exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}
test.describe('in Quanta, with a folder, a long note and a source', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Miscellaneous'],
      notes: [
        { title: 'Penmoss Roadmap', markdown: 'Plans for Penmoss.\n' },
        { title: 'Long', markdown: `${LONG}\n` },
        { title: 'Source', markdown: '## Plan\n\nFirst line.\n' },
      ],
    },
  });

  // T66, items 2, 3.
  test('search finds words inside words, and filters by notebook before folder', async ({
    page,
    host,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await openNote(page, 'Long');
    await host.seed({ name: 'Work', notes: [{ title: 'Penmoss Parser', markdown: 'Moss.\n' }] });
    await expect(section(page, 'Work').getByTestId('section-sync')).toHaveAttribute(
      'data-state',
      'synced',
      { timeout: 40_000 },
    );
    await openNote(page, 'Penmoss Parser', 'Work');
    await page.keyboard.press('ControlOrMeta+Shift+KeyF');
    const search = page.getByTestId('search');
    await search.getByRole('combobox', { name: 'Search notes' }).fill('moss');
    const hits = search.locator('.search-hit');
    // "moss" is inside "Penmoss": both notebooks' notes are found.
    await expect(hits.filter({ hasText: 'Penmoss Roadmap' })).toHaveCount(1);
    await expect(hits.filter({ hasText: 'Penmoss Parser' })).toHaveCount(1);

    // The Notebook filter comes before Folder.
    const notebook = search.getByRole('combobox', { name: 'Notebook' });
    const folder = search.getByRole('combobox', { name: 'Folder' });
    expect((await notebook.boundingBox())!.x).toBeLessThan((await folder.boundingBox())!.x);
    await notebook.selectOption({ label: 'Work' });
    await expect(hits.filter({ hasText: 'Penmoss Parser' })).toHaveCount(1);
    await expect(hits.filter({ hasText: 'Penmoss Roadmap' })).toHaveCount(0);
    // Folder lists the chosen notebook's folders: Work has none, Quanta has Miscellaneous.
    await expect(folder.locator('option', { hasText: 'Miscellaneous' })).toHaveCount(0);
    await notebook.selectOption({ label: 'Quanta' });
    await expect(hits.filter({ hasText: 'Penmoss Roadmap' })).toHaveCount(1);
    await expect(hits.filter({ hasText: 'Penmoss Parser' })).toHaveCount(0);
    await expect(folder.locator('option', { hasText: 'Miscellaneous' })).toHaveCount(1);
    if (SHOTS) await search.screenshot({ path: `${SHOTS}/search-notebook.png` });
    expect(errors).toEqual([]);
  });
});

const tree = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });

async function newNoteFromButtonAndEnter(page: Page, title: string, text = ''): Promise<string> {
  await page
    .getByRole('button', { name: /^New Note/ })
    .first()
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  if (text) await page.keyboard.type(text);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

// T39 pass 2.
test('search says when nothing matches, as the palette does', async ({ page }) => {
  const errors = collectErrors(page);
  // In a folder of this test's own, holding one note; a git notebook searches its words on this
  // device (A826), so the answer is the notebook's index's, never chance.
  await page.goto('/');
  await expect(tree(page)).toBeVisible();
  const folderName = `Quiet ${RUN}`;
  await page.getByTestId('tree-root-drop').click();
  // The notebook's New Folder, on its name's row (T53 item 4).
  await (await notebookAction(page, 'New Folder')).click();
  const name = page.getByRole('textbox', { name: 'New folder name' });
  await name.fill(folderName);
  await name.press('Enter');
  await expect(tree(page).getByRole('treeitem', { name: folderName, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // New notes go into the chosen folder.
  const quiet = await newNoteFromButtonAndEnter(page, 'Quiet shelf', 'Plain words only.');
  // This device's index reads the stored note (A7).
  await expect.poll(async () => (await storedRecord(page, quiet))?.text ?? '').toContain('only.');

  await page.keyboard.press(SEARCH);
  const search = page.getByTestId('search');
  await expect(search).toBeVisible();
  const folder = search.getByRole('combobox', { name: 'Folder' });
  await folder.selectOption({ label: folderName });
  const input = search.getByRole('combobox', { name: 'Search notes' });
  // The folder holds the note, found by its words.
  await input.fill('Quiet shelf');
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      search
        .locator('[role="option"][data-note-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-note-id'))),
    )
    .toEqual([quiet]);

  // Made-up letters, unlike this run's suffix, which other notes share.
  const word = 'qzxvjwkp';
  await input.fill(word);
  await page.keyboard.press('Enter');
  await expect(search.getByTestId('search-empty')).toHaveText(`No notes match “${word}”`);
  await expect(search.getByTestId('search-status')).toHaveText(/^No results on this device/);
  expect(errors).toEqual([]);
});
