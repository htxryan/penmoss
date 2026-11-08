import { anotherMac, expect, seeded, test, type Page } from './fixtures';
import { NEW_NOTE } from './keys';
import { storedSetting } from './stored';
import { readRemote } from './support/remote';

// T20: the command palette (⌘K, respecting A42), quick open, the ⌘E recent-notes switcher,
// the cheat sheet, and rebinding a shortcut in Settings (conflicts, immediate effect, and on
// another Mac through the git notebook, whose `device` map holds the bindings, A827).

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const TAG = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

const idOf = (page: Page) => ULID.exec(new URL(page.url()).pathname)![1]!;

/** A new note from the keyboard (⌘⌥N), with a title and one paragraph; returns its id. */
async function newNote(page: Page, title: string, text = 'Some text'): Promise<string> {
  // The keyboard dispatcher attaches once the app has mounted.
  await expect(page.getByTestId('app-root')).toBeVisible();
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return idOf(page);
}

/**
 * Presses a key that moves the selection until `settled` passes. When the note gains focus
 * (Enter in the title or in the link field), ProseMirror re-applies the editor's own selection
 * 20 ms later if the page's differs from the last one it read (prosemirror-view's focus
 * handler), so a key sent inside that window, before its `selectionchange` is read, is undone:
 * the caret or selection snaps back (about 1 run in 8; 3 in 21 with the CPU throttled 4×). No state shows the
 * window has passed, but these keys are idempotent, so pressing again until the result shows
 * is waiting on that result (A43).
 */
async function pressUntil(page: Page, key: string, settled: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.keyboard.press(key);
    await settled();
  }).toPass();
}

test('the palette runs commands and opens notes from the keyboard', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toBeVisible();

  // ⌘K with nothing selected opens the palette; a command runs from it.
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await expect(palette).toBeVisible();
  const input = palette.getByRole('combobox', { name: 'Command Palette' });
  await expect(input).toBeFocused();
  await input.fill('new note');
  await expect(palette.getByRole('option').first()).toContainText('New Note');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  const first = idOf(page);
  await page.keyboard.type(`Palette target ${TAG}`);

  await newNote(page, `Another note ${TAG}`);

  // Notes are fuzzy-searched too.
  await page.keyboard.press('ControlOrMeta+KeyK');
  await input.fill(`ptarget ${TAG}`);
  const option = palette.getByRole('option').first();
  await expect(option).toContainText(`Palette target ${TAG}`);
  await expect(option).toHaveAttribute('data-kind', 'note');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/notes/${first}$`));
  await expect(body(page)).toBeFocused();

  // Esc closes it and gives focus back.
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(body(page)).toBeFocused();

  // ⌘P quick open lists notes only.
  await page.keyboard.press('ControlOrMeta+KeyP');
  const quick = page.getByRole('dialog', { name: 'Quick Open' });
  await expect(quick).toBeVisible();
  await quick.getByRole('combobox').fill('new note');
  await expect(quick.locator('[data-kind="command"]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Quick open run from the palette starts empty, with the keys in its field, not in
  // the note behind it (B11).
  await page.keyboard.press('ControlOrMeta+KeyK');
  await input.fill('Quick open');
  await page.keyboard.press('Enter');
  await expect(quick).toBeVisible();
  const quickInput = quick.getByRole('combobox');
  await expect(quickInput).toBeFocused();
  await expect(quickInput).toHaveValue('');
  const before = await body(page).textContent();
  await page.keyboard.type('x');
  await expect(quickInput).toHaveValue('x');
  await page.keyboard.press('Escape');
  await expect(quick).toBeHidden();
  expect(await body(page).textContent()).toBe(before);

  // ⌘/ shows the cheat sheet with the bound keys.
  await page.keyboard.press('ControlOrMeta+Slash');
  const cheat = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
  await expect(cheat).toContainText('Switch to a Recent Note');
  await page.keyboard.press('Escape');
  await expect(cheat).toBeHidden();
  expect(errors).toEqual([]);
});

test('⌘K links selected text in the note instead of opening the palette (A42)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Link target ${TAG}`, 'Penmoss home');
  const toolbar = page.getByTestId('selection-toolbar');
  // A43: the selection settles before the next key (the toolbar shows once it has).
  await pressUntil(page, 'Shift+Home', () => expect(toolbar).toBeVisible({ timeout: 1000 }));
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.getByRole('textbox', { name: 'Link address' })).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Command Palette' })).toBeHidden();
  await page.keyboard.type('penmoss.app');
  await page.keyboard.press('Enter');
  await expect(body(page).locator('a[href="https://penmoss.app"]')).toHaveText('Penmoss home');
  // Inline code is ⌘⇧E; ⌘E stays the switcher's.
  // The caret alone: the toolbar goes, so seeing it again below means the new selection.
  // (Enter in the link field gave the note focus again: End can snap back as above.)
  await pressUntil(page, 'End', () => expect(toolbar).toBeHidden({ timeout: 1000 }));
  await pressUntil(page, 'Shift+Home', () => expect(toolbar).toBeVisible({ timeout: 1000 }));
  await page.keyboard.press('ControlOrMeta+Shift+KeyE');
  await expect(body(page).locator('code')).toHaveText('Penmoss home');
  expect(errors).toEqual([]);
});

test('⌘E cycles recent notes like an app switcher', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const a = await newNote(page, `Recent A ${TAG}`);
  const b = await newNote(page, `Recent B ${TAG}`);
  await newNote(page, `Recent C ${TAG}`);

  // One tap goes straight back to the previous note (B), like an app switcher.
  await page.keyboard.press('ControlOrMeta+KeyE');
  await expect(page).toHaveURL(new RegExp(`/notes/${b}$`));
  const switcher = page.getByRole('dialog', { name: 'Recent notes' });
  await expect(switcher).toBeHidden();

  // Hold the modifier, E twice, let go: two back (C was before B, then A).
  await page.keyboard.down('ControlOrMeta');
  await page.keyboard.press('KeyE');
  await expect(switcher.getByRole('option', { selected: true })).toContainText(`Recent C ${TAG}`);
  await page.keyboard.press('KeyE');
  await expect(switcher.getByRole('option', { selected: true })).toContainText(`Recent A ${TAG}`);
  await page.keyboard.up('ControlOrMeta');
  await expect(switcher).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/notes/${a}$`));
  await expect(body(page)).toBeFocused();
  expect(errors).toEqual([]);
});

test('rebinding a shortcut warns on conflicts, takes effect at once and reaches another Mac', async ({
  page,
  browser,
  host,
  notebook,
}) => {
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  await page.goto('/settings/shortcuts');
  const row = page.locator('tr[data-command-row="note.new"]');
  // Until the bindings are read the rows show the defaults (A627).
  await expect(page.getByTestId('shortcuts-settings')).not.toHaveAttribute(
    'data-bindings',
    'loading',
    { timeout: 15_000 },
  );

  // A combination another command uses is a conflict, named.
  await row.getByRole('button', { name: 'Change the Shortcut for New Note' }).click();
  await page.keyboard.press('ControlOrMeta+KeyE');
  const conflict = row.getByTestId('shortcut-conflict');
  await expect(conflict).toContainText('Switch to a Recent Note');
  await conflict.getByRole('button', { name: 'Cancel' }).click();
  await expect(conflict).toBeHidden();

  // Off a Mac, Ctrl+Alt with a letter is AltGr, which types: refused (A90).
  if (process.platform !== 'darwin') {
    await row.getByRole('button', { name: 'Change the Shortcut for New Note' }).click();
    await page.keyboard.press('Control+Alt+KeyM');
    await expect(row.getByRole('alert')).toContainText('AltGr');
  }

  // A free one is taken at once, and stored in the notebook.
  await row.getByRole('button', { name: 'Change the Shortcut for New Note' }).click();
  await page.keyboard.press('ControlOrMeta+Shift+KeyL');
  await expect(row.getByTestId('keys-note.new')).toContainText('L');
  await expect(row.getByRole('status')).toContainText('New Note is now');
  const onL = [expect.stringMatching(/Shift\+L$/)];
  await expect.poll(() => storedSetting(page, 'keys.note.new')).toEqual(onL);

  // It works right away, and the old keys no longer do.
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  // A reload reads the bindings from the local workspace copy a moment after first paint.
  await expect(page.locator('button[data-command="note.new"]')).toHaveAttribute(
    'aria-keyshortcuts',
    /L$/,
  );
  await page.keyboard.press(NEW_NOTE);
  await page.waitForTimeout(300);
  await expect(page).not.toHaveURL(ULID);
  await page.keyboard.press('ControlOrMeta+Shift+KeyL');
  await expect(page).toHaveURL(ULID);

  // Git carries it: the remote's notebook has it, and another Mac on it uses it.
  await expect
    .poll(async () => (await readRemote(host, remote)).setting('keys.note.new'), {
      timeout: 60_000,
      intervals: [2_000],
    })
    .toEqual(onL);
  const other = await anotherMac(browser, { remote });
  try {
    await other.page.goto('/settings/shortcuts');
    await expect(
      other.page.locator('tr[data-command-row="note.new"]').getByTestId('keys-note.new'),
    ).toContainText('L', { timeout: 40_000 });
  } finally {
    await other.context.close();
  }
  expect(errors).toEqual([]);
});
