import { expect, test, type Page } from './fixtures';
import { NEW_NOTE } from './keys';
import { storedRecord } from './stored';
import { MEANING_ELSEWHERE } from '../../src/search/meaning';

// T22 on a git notebook (T59): search from the shortcut and the palette, highlighted snippets,
// the tag filter, all from this device's index of the notebook (A826), the same offline. This
// stand-in Mac has no search by meaning (search-meaning.spec.ts has it): results match words
// and say Words only (A1156).

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
// Ends in digits, which the porter stemmer leaves alone, so prefixes of it stay prefixes.
const RUN = `${Date.now().toString(36)}${100 + Math.floor(Math.random() * 900)}`;
const SEARCH = 'ControlOrMeta+Shift+KeyF';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    // Requests made while the context is offline fail by design (as in offline.spec.ts).
    if (
      message.type() === 'error' &&
      !/ERR_INTERNET_DISCONNECTED|WebSocket|Failed to fetch|net::/.test(message.text())
    ) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function newNote(page: Page, title: string, text: string): Promise<string> {
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

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
  const errors = collectErrors(page);
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
  const errors = collectErrors(page);
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
