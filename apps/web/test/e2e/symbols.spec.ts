import { expect, seeded, test, type Locator, type Page } from './fixtures';
import { LINE_END, LINE_START, NEW_NOTE, NOTE_WINDOW, SYMBOL, SYMBOL_PICKER } from './keys';
import { storedDocumentText, storedSetting } from './stored';
import { readRemote } from './support/remote';
import { ULID, body, collectErrors } from './support/app';

// T44 (#107, D36, A740–A746): line symbols. A line's leading glyphs (★ ? ! 💡 →) are plain
// text, drawn in the margin, toggled by slot keys, the picker, the slash menu and the palette;
// the markdown is the glyph and a space. Settings → Symbols edits the synced list. The Mac
// app's suite checks the keys and the menus there (apps/desktop/test/e2e/symbols.spec.ts).

const WINDOW = /\/window\/notes\/([0-9A-HJKMNP-TV-Z]{26})(\?.*)?$/;
const RUN = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

async function newNote(page: Page, title: string): Promise<string> {
  await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(body(page)).toBeFocused();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

/** The note's markdown (the source view, T11) holds each line; the view is then closed. */
async function expectMarkdown(page: Page, ...lines: string[]): Promise<void> {
  await page.keyboard.press('ControlOrMeta+Shift+KeyM');
  const source = page.getByTestId('note-markdown');
  for (const line of lines) await expect(source).toContainText(line);
  await page.keyboard.press('ControlOrMeta+Shift+KeyM');
  await expect(source).toBeHidden();
}

/** Where the line's own text starts on screen: its first visible character. */
async function textLeft(page: Page, text: string): Promise<number> {
  return body(page).evaluate((element, wanted) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const at = (node.nodeValue ?? '').indexOf(wanted);
      if (at < 0 || node.parentElement?.closest('.pm-symbol-run, .pm-symbols')) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      return range.getBoundingClientRect().left;
    }
    return Number.NaN;
  }, text);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
});

/**
 * The block's drag handle, shown by hovering the line's text, ends left of its first symbol
 * shown: the margin keeps its 24 px slot clear (A969).
 */
async function expectHandleClear(page: Page, line: Locator, margin: Locator): Promise<void> {
  const handle = page.getByTestId('drag-handle');
  const text = (await line.boundingBox())!;
  await page.mouse.move(text.x + text.width - 4, text.y + text.height / 2);
  await expect(handle).toBeVisible();
  const grip = (await handle.boundingBox())!;
  const first = (await margin.locator('.pm-symbol:visible').first().boundingBox())!;
  expect(grip.x + grip.width).toBeLessThanOrEqual(first.x + 0.5);
  // Level with the line, so it is the line's own handle.
  expect(Math.abs(grip.y + grip.height / 2 - (first.y + first.height / 2))).toBeLessThan(
    text.height,
  );
}

test('T44: slot keys toggle symbols in the margin, in list order, as plain text, with undo', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Symbols ${RUN}`);
  await page.keyboard.type('Before');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Call the bank');
  const left = await textLeft(page, 'Call the bank');
  // A note without symbols keeps no gutter (A-NEW-3).
  await expect(body(page)).not.toHaveAttribute('data-symbol-slots');

  await page.keyboard.press(SYMBOL(6));
  await page.keyboard.press(SYMBOL(2));
  const margin = body(page).locator('p').nth(1).getByTestId('line-symbols');
  await expect(margin).toBeVisible();
  await expect(margin.locator('.pm-symbol')).toHaveText(['★', '→']);
  // In the gutter, outside the text column, which made room for two (A-NEW-3): every line's
  // text starts at the same place, the plain line's too.
  await expect(body(page)).toHaveAttribute('data-symbol-slots', '2');
  const column = (await body(page).boundingBox())!;
  const box = (await margin.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(column.x + 1);
  expect(box.x).toBeGreaterThanOrEqual(left - 1);
  expect(
    Math.abs((await textLeft(page, 'Call the bank')) - (await textLeft(page, 'Before'))),
  ).toBeLessThan(0.5);
  expect(await textLeft(page, 'Call the bank')).toBeGreaterThan(left);
  // Coloured with the theme's tokens.
  const colour = await margin
    .locator('.pm-symbol')
    .first()
    .evaluate((glyph) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--pm-callout-warning)';
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return { actual: getComputedStyle(glyph).color, expected };
    });
  expect(colour.actual).toBe(colour.expected);

  // The caret skips the symbols: the line's start is its text.
  await page.keyboard.press(LINE_START);
  await page.keyboard.type('Now: ');
  // ← from the start of the text goes to the line before, past the symbols.
  await page.keyboard.press(LINE_START);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('!');
  // Backspace at the start of the text removes the last symbol.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(LINE_START);
  await page.keyboard.press('Backspace');
  await expect(margin.locator('.pm-symbol')).toHaveText(['★']);
  await expectMarkdown(page, 'Before!', '★ Now: Call the bank');

  // Undo brings the symbol back; redo takes it again.
  await body(page).click();
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect(body(page).locator('p').nth(1).locator('.pm-symbol')).toHaveText(['★', '→']);
  await page.keyboard.press('ControlOrMeta+Shift+KeyZ');
  await expect(body(page).locator('p').nth(1).locator('.pm-symbol')).toHaveText(['★']);

  // A glyph typed by hand is a symbol the same way; one not on the list is text.
  await page.keyboard.press(LINE_END);
  await page.keyboard.press('Enter');
  await page.keyboard.type('💡 Typed idea');
  await page.keyboard.press('Enter');
  await page.keyboard.type('☆ Not a symbol');
  await expect(body(page).getByTestId('line-symbols')).toHaveCount(2);
  await expectMarkdown(page, '★ Now: Call the bank', '💡 Typed idea', '☆ Not a symbol');
  expect(errors).toEqual([]);
});

test('T44: an input method composes visibly at the start of a symbol line (review)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Symbol IME ${RUN}`);
  await page.keyboard.type('★ Hello');
  await page.keyboard.press(LINE_START);
  const cdp = await page.context().newCDPSession(page);
  const compose = async (text: string) => {
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
    // What is being composed is in the line's text, not in the hidden symbols.
    await expect(body(page).locator('.pm-symbol-run').first()).toHaveText(/^★ $/);
    await cdp.send('Input.insertText', { text });
  };
  await compose('word ');
  await expect(body(page).locator('p').first()).toContainText('word Hello');
  await expect(body(page).locator('.pm-symbol')).toHaveText(['★']);

  // "? " on an empty line, then a word composed after it.
  await page.keyboard.press(LINE_END);
  await page.keyboard.press('Enter');
  await page.keyboard.type('? ');
  await expect(body(page).locator('.pm-symbol')).toHaveText(['★', '?']);
  await compose('Why');
  await expectMarkdown(page, '★ word Hello', '? Why');
  expect(errors).toEqual([]);
});

test('T44: a selection over a heading and a list takes a symbol on every line at once', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Symbol lines ${RUN}`);
  await page.keyboard.type('## Open questions');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- First');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second');
  // From the heading to the second item.
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press(SYMBOL(3));
  await expect(body(page).getByTestId('line-symbols')).toHaveCount(3);
  // Again, on the same lines: every one has it, so it goes from all of them.
  await page.keyboard.press(SYMBOL(3));
  await expect(body(page).getByTestId('line-symbols')).toHaveCount(0);
  await page.keyboard.press(SYMBOL(3));
  await expect(body(page).getByTestId('line-symbols')).toHaveCount(3);
  await expectMarkdown(page, '## ? Open questions', '- ? First', '- ? Second');
  expect(errors).toEqual([]);
});

test('T44: every bullet and number shows in a list holding a symbol line, unfocused (review)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Symbol markers ${RUN}`);
  await page.keyboard.type('- One\nTwo\nThree');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press(SYMBOL(2));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(LINE_END);
  await page.keyboard.type('\n\n1. First\nSecond\nThird');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press(SYMBOL(3));
  await expect(body(page).getByTestId('line-symbols')).toHaveCount(2);
  await expect(body(page).locator('ul > li')).toHaveCount(3);
  await expect(body(page).locator('ol > li')).toHaveCount(3);

  // Unfocused, the long-note skipping is on (T31). Containing an item would clip its outside
  // marker, so each item's marker area must change when markers are made transparent.
  await body(page).evaluate((element) => (element as HTMLElement).blur());
  await expect(page.locator('.ProseMirror-focused')).toHaveCount(0);
  await page.mouse.move(2, 2);
  const items = await body(page)
    .locator('ul > li, ol > li')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { x: Math.round(box.left - 22), y: Math.round(box.top), width: 20, height: 20 };
      }),
    );
  const shots = () => Promise.all(items.map((clip) => page.screenshot({ clip })));
  const shown = await shots();
  await page.addStyleTag({ content: '.note-body li::marker { color: transparent; }' });
  const hidden = await shots();
  shown.forEach((shot, index) => {
    expect(shot.equals(hidden[index]!), `item ${index + 1} has a marker`).toBe(false);
  });
  expect(errors).toEqual([]);
});

test('A1632: ⌃1 steps a line through ☐, ☑ and no box; list items come from Add', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Symbol checkbox ${RUN}`);
  await page.keyboard.type('Buy milk');
  const item = body(page).locator('li[data-checked]');
  await page.keyboard.press(SYMBOL(1));
  await expect(item).toHaveAttribute('data-checked', 'false');
  await expect(item).toContainText('Buy milk');
  await page.keyboard.press(SYMBOL(1));
  await expect(item).toHaveAttribute('data-checked', 'true');
  await expectMarkdown(page, '- [x] Buy milk');
  await item.locator('p').click();
  await page.keyboard.press(SYMBOL(1));
  await expect(item).toHaveCount(0);
  await expect(body(page).locator('p').first()).toHaveText('Buy milk');

  // Settings → Symbols: the Checkbox row, and Add offering what the list lacks.
  await page.goto('/settings/symbols');
  const settings = page.getByTestId('symbols-settings');
  const rows = settings.getByTestId('symbol-row');
  const restore = settings.getByRole('button', { name: 'Restore Defaults' });
  await expect(settings.getByTestId('symbol-move-1')).toBeEnabled();
  try {
    if (await restore.isEnabled()) await restore.click();
    await expect(rows.first()).toContainText('Checkbox');
    await expect(rows.first()).toContainText('☐ → ☑ → no box');
    await settings.getByTestId('symbol-add').click();
    const menu = page.getByRole('menu', { name: 'Add' });
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Symbol',
      /Checkbox/,
      'Bulleted List Item',
      'Numbered List Item',
      /Strikethrough/,
    ]);
    await expect(menu.getByRole('menuitem', { name: /Checkbox/ })).toBeDisabled();
    await expect(menu.getByRole('menuitem', { name: /Strikethrough/ })).toBeDisabled();
    // Wholly inside the settings column, which would clip it.
    const column = (await page.locator('.settings-content').boundingBox())!;
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(column.x);
    await menu.getByRole('menuitem', { name: 'Numbered List Item' }).click();
    await expect(rows).toHaveCount(8);
    await expect
      .poll(async () =>
        ((await storedSetting(page, 'symbols.list')) as unknown[] | undefined)?.at(-1),
      )
      .toEqual({ kind: 'ordered' });
  } finally {
    if (await restore.isEnabled()) await restore.click();
    await expect(rows).toHaveCount(7);
  }
  expect(errors).toEqual([]);
});

test('T44: the picker, the slash menu, the palette and a click in the margin', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Symbol picker ${RUN}`);
  await page.keyboard.type('Pick one');
  await page.keyboard.press(SYMBOL_PICKER);
  const picker = page.getByRole('menu', { name: 'Symbols' });
  await expect(picker).toBeVisible();
  // Each named by its glyph (T51 item 12, A940), after the Checkbox on slot 1 (A1632).
  await expect(picker.getByRole('menuitemcheckbox')).toHaveText([
    /☐/,
    /★/,
    /\?/,
    /!/,
    /💡/,
    /→/,
    /⊘/,
  ]);
  await expect(picker.getByRole('menuitemcheckbox').last()).toHaveAccessibleName('Strikethrough');
  await expect(picker.getByRole('menuitemcheckbox').first()).toHaveAccessibleName('Checkbox');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(body(page).locator('.pm-symbol')).toHaveText(['?']);
  await expect(body(page)).toBeFocused();

  // The slash menu's Symbol opens it at the line.
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second /symbol');
  await page.keyboard.press('Enter');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('menuitemcheckbox', { name: /★/ })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await picker.getByRole('menuitemcheckbox', { name: /★/ }).click();
  await expect(body(page).locator('p').nth(1).locator('.pm-symbol')).toHaveText(['★']);
  await expect(body(page).locator('p').nth(1)).toContainText('Second');

  // The palette runs a slot by its glyph (A940).
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.keyboard.type('Toggle Symbol !');
  await page.keyboard.press('Enter');
  await expect(body(page).locator('p').nth(1).locator('.pm-symbol')).toHaveText(['★', '!']);

  // A click on a line's symbols opens the picker for that line, ticked as it is.
  await body(page).locator('p').first().getByTestId('line-symbols').click();
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('menuitemcheckbox', { name: /\?/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();

  // Edit symbols… goes to Settings → Symbols.
  await page.keyboard.press(SYMBOL_PICKER);
  await picker.getByRole('menuitem', { name: 'Edit Symbols…' }).click();
  await expect(page).toHaveURL(/\/settings\/symbols$/);
  await expect(page.getByTestId('symbols-settings')).toBeVisible();
  expect(errors).toEqual([]);
});

test('T44: Settings → Symbols edits the synced list; a removed glyph shows as text again', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await page.goto('/');
  const id = await newNote(page, `Symbol settings ${RUN}`);
  await page.keyboard.type('? A question');
  await expect(body(page).getByTestId('line-symbols')).toHaveCount(1);
  const note = page.url();
  // Stored before the page goes (A622, A624): the note is opened again after Settings.
  await expect.poll(() => storedDocumentText(page, id)).toContain('A question');

  await page.goto('/settings/symbols');
  const settings = page.getByTestId('symbols-settings');
  await expect(settings).toBeVisible();
  // Look and Feel first: Appearance, Sidebar, Note and Symbols (A551, PEN-146); then Writing,
  // then the notebooks; nothing of the server's (T59: no Git Mirror, no Devices and tokens).
  const nav = page.getByRole('navigation', { name: 'Settings Sections' });
  await expect(nav.getByRole('group', { name: 'Look and Feel' })).toBeVisible();
  await expect(nav.getByRole('group', { name: 'Writing' })).toBeVisible();
  const links = page.getByRole('navigation', { name: 'Settings Sections' }).getByRole('link');
  await expect(links.first()).toHaveText('Appearance');
  const sections = await links.allTextContents();
  expect(sections.slice(0, 4)).toEqual(['Appearance', 'Sidebar', 'Note', 'Symbols']);
  const order = ['Daily Notes', 'Quick Capture', 'Keyboard Shortcuts', 'All Notebooks'].map(
    (name) => sections.indexOf(name),
  );
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(sections).not.toContain('Git Mirror');
  expect(sections).not.toContain('Devices and Agent Tokens');
  const rows = settings.getByTestId('symbol-row');
  const restore = settings.getByRole('button', { name: 'Restore Defaults' });
  await expect(settings.getByTestId('symbol-glyph-2')).toBeEnabled();
  try {
    // A shared workspace: start from the defaults.
    if (await restore.isEnabled()) await restore.click();
    await expect(rows).toHaveCount(7);
    await expect(settings.getByTestId('symbol-keys-2')).toHaveText(/⌃2|Alt\+Shift\+2/);
    // No names to give (A940): a row is its keys, its glyph and its colour.
    await expect(rows.first().getByRole('textbox')).toHaveCount(0);
    // A focused control in the last row stays clear of the buttons below (T51 item 11).
    const last = settings.getByTestId('symbol-remove-7');
    await last.focus();
    const lastBox = (await last.boundingBox())!;
    const addBox = (await settings.getByTestId('symbol-add').boundingBox())!;
    // Its 3 px focus ring included.
    expect(lastBox.y + lastBox.height + 3).toBeLessThanOrEqual(addBox.y);

    // The glyph picker (T51 item 9; A1568's Characters): a modal, its search focused, Characters
    // only; one another symbol has is marked; a pasted glyph that is markdown is refused; one is
    // found by name and chosen.
    await settings.getByTestId('symbol-glyph-2').click();
    const glyphs = page.getByTestId('symbol-glyph-2-picker');
    await expect(glyphs.getByRole('dialog', { name: 'Choose a Symbol' })).toBeVisible();
    const glyphSearch = glyphs.getByTestId('symbol-glyph-2-picker-search');
    await expect(glyphSearch).toBeFocused();
    await expect(glyphs.getByRole('tab')).toHaveCount(0);
    await expect(
      glyphs.getByRole('option', { name: 'Question Mark, Already symbol 3' }),
    ).toHaveAttribute('aria-disabled', 'true');
    await glyphSearch.fill('#');
    await expect(glyphs.getByRole('alert')).toContainText('Glyph cannot hold #');
    await glyphSearch.fill('flag');
    await glyphs.getByRole('option', { name: 'Flag', exact: true }).click();
    await expect(glyphs).toBeHidden();
    await expect(settings.getByTestId('symbol-glyph-2')).toHaveText('⚑');
    await expect(settings.getByTestId('symbol-glyph-2')).toBeFocused();

    // The colour picker (T51 item 10): a theme colour, then a colour of one's own by hex.
    await settings.getByTestId('symbol-colour-2').click();
    await settings
      .getByTestId('symbol-colour-2-picker')
      .getByRole('radio', { name: 'Rose' })
      .click();
    await expect(settings.getByTestId('symbol-colour-2')).toContainText('Rose');
    await settings.getByTestId('symbol-colour-4').click();
    await settings.getByTestId('symbol-colour-4-hex').fill('#3366CC80');
    await settings.getByTestId('symbol-colour-4-hex').press('Enter');
    await page.keyboard.press('Escape');
    await expect(settings.getByTestId('symbol-colour-4')).toContainText('#3366CC80');

    // Show the Keys (PEN-146): the count against the limit, and a row moved by its handle from
    // the keyboard, which keeps focus, says its new place, and back again.
    await expect(settings.getByTestId('symbols-count')).toHaveText('7 of 9');
    await settings.getByTestId('symbol-move-2').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(settings.getByTestId('symbol-glyph-3')).toHaveText('⚑');
    await expect(settings.getByTestId('symbols-notice')).toContainText('⚑ is now symbol 3');
    await expect(settings.getByTestId('symbol-move-3')).toBeFocused();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(settings.getByTestId('symbol-glyph-2')).toHaveText('⚑');

    await settings.getByRole('button', { name: 'Remove ?' }).click();
    await expect(rows).toHaveCount(6);
    const edited = [
      { kind: 'checkbox' },
      { glyph: '⚑', name: '⚑', colour: 'calloutFailure' },
      { glyph: '!', name: 'Follow-up', colour: '#3366cc80' },
      { glyph: '💡', name: 'Idea', colour: 'calloutTip' },
      { glyph: '→', name: 'Next', colour: 'accent' },
      { kind: 'strike' },
    ];
    await expect.poll(() => storedSetting(page, 'symbols.list')).toEqual(edited);
    // Synced: the notebook's device settings reach its remote (A827).
    await expect
      .poll(async () => (await readRemote(host, seeded(notebook).remote)).setting('symbols.list'), {
        timeout: 90_000,
      })
      .toEqual(edited);
    // "?" is text again in the note, which did not change.
    await page.goto(note);
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
    await expect(body(page).getByTestId('line-symbols')).toHaveCount(0);
    await expect(body(page).locator('p').first()).toHaveText('? A question');
  } finally {
    await page.goto('/settings/symbols');
    await expect(settings.getByTestId('symbol-glyph-2')).toBeEnabled();
    if (await restore.isEnabled()) await restore.click();
    await expect(rows).toHaveCount(7);
    await expect.poll(() => storedSetting(page, 'symbols.list')).toBeUndefined();
    // Synced with the defaults back.
    await page.locator('.settings-bar .back-link').click();
    await expect(page.getByTestId('section-sync')).toHaveAttribute('data-state', 'synced', {
      timeout: 40_000,
    });
  }
  expect(errors).toEqual([]);
});

test('A1588: an emoji keeps its own colours, so its colour is disabled with a note, and kept', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/settings/symbols');
  const settings = page.getByTestId('symbols-settings');
  const rows = settings.getByTestId('symbol-row');
  const restore = settings.getByRole('button', { name: 'Restore Defaults' });
  const NOTE = 'This emoji’s colour can’t be changed.';
  await expect(settings.getByTestId('symbol-glyph-2')).toBeEnabled();
  try {
    if (await restore.isEnabled()) await restore.click();
    await expect(rows).toHaveCount(7);
    // 💡, a default: its colour is disabled, the note beside it and describing it, and the
    // glyph drawn without its colour.
    const idea = settings.getByTestId('symbol-colour-5');
    await expect(settings.getByTestId('symbol-glyph-5')).toHaveText('💡');
    await expect(idea).toBeDisabled();
    await expect(settings.getByTestId('symbol-colour-note-5')).toHaveText(NOTE);
    await expect(idea).toHaveAccessibleDescription(NOTE);
    await expect(settings.getByTestId('symbol-glyph-5')).not.toHaveAttribute('style', /color/);
    // ★ takes its colour.
    const star = settings.getByTestId('symbol-colour-2');
    await expect(star).toBeEnabled();
    await expect(star).toContainText('Orange');
    await expect(settings.getByTestId('symbol-colour-note-2')).toHaveCount(0);
    await expect(settings.getByTestId('symbol-glyph-2')).toHaveAttribute('style', /color/);

    // An emoji chosen in ★'s row: its colour is disabled with the note, and kept.
    await settings.getByTestId('symbol-glyph-2').click();
    let picker = page.getByTestId('symbol-glyph-2-picker');
    await picker.getByTestId('symbol-glyph-2-picker-search').fill('fire');
    await picker.getByRole('option', { name: 'Fire', exact: true }).click();
    await expect(settings.getByTestId('symbol-glyph-2')).toHaveText('🔥');
    await expect(star).toBeDisabled();
    await expect(settings.getByTestId('symbol-colour-note-2')).toHaveText(NOTE);
    await expect(star).toContainText('Orange');
    await expect
      .poll(async () => ((await storedSetting(page, 'symbols.list')) as unknown[] | undefined)?.[1])
      .toEqual({ glyph: '🔥', name: '🔥', colour: 'calloutWarning' });

    // A glyph that takes a colour again: the colour is back, as it was.
    await settings.getByTestId('symbol-glyph-2').click();
    picker = page.getByTestId('symbol-glyph-2-picker');
    await picker.getByTestId('symbol-glyph-2-picker-search').fill('star');
    // Two are named Star: the symbol and the emoji (⭐).
    await picker
      .getByRole('option', { name: 'Star', exact: true })
      .filter({ hasText: '★' })
      .click();
    await expect(settings.getByTestId('symbol-glyph-2')).toHaveText('★');
    await expect(star).toBeEnabled();
    await expect(star).toContainText('Orange');
    await expect(settings.getByTestId('symbol-colour-note-2')).toHaveCount(0);
    await expect(settings.getByTestId('symbol-glyph-2')).toHaveAttribute('style', /color/);
  } finally {
    if (await restore.isEnabled()) await restore.click();
    await expect(rows).toHaveCount(7);
  }
  expect(errors).toEqual([]);
});

test('T44: the slot keys work in a note window too (T45)', async ({ page, context }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const title = `Symbol window ${RUN}`;
  await newNote(page, title);
  await page.keyboard.type('In a window');
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.keyboard.press(NOTE_WINDOW),
  ]);
  await expect(popup).toHaveURL(WINDOW);
  await expect(popup.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  // A note window has no room for the panel beside the text: open, as by default, it lies over
  // the text (T53 item 9, A985). Closed first, so the click reaches the paragraph.
  const columns = popup.locator('.note-columns');
  if ((await columns.getAttribute('data-panel')) === 'open') {
    await popup.getByTestId('note-panel-close').click();
    await expect(columns).toHaveAttribute('data-panel', 'closed');
  }
  const popupBody = body(popup);
  await popupBody.locator('p').first().click();
  await popup.keyboard.press(SYMBOL(5));
  await expect(popupBody.locator('.pm-symbol')).toHaveText(['💡']);
  // The main window follows the edit.
  await page.bringToFront();
  await expect(body(page).locator('.pm-symbol')).toHaveText(['💡']);
  await popup.close();
  expect(errors).toEqual([]);
});

test('T52: symbols in a table cell, by key and the slash menu, before the cell’s text', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Symbol cells ${RUN}`);
  await page.keyboard.type('| Task | Owner |');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Budget');
  const cell = body(page).locator('td').first();
  const left = await textLeft(page, 'Budget');
  await page.keyboard.press(SYMBOL(2));
  await page.keyboard.press(SYMBOL(4));
  const symbols = cell.getByTestId('line-symbols');
  await expect(symbols.locator('.pm-symbol')).toHaveText(['★', '!']);
  // Inside the cell, before its text (the page's margin is out of reach there).
  const cellBox = (await cell.boundingBox())!;
  const box = (await symbols.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(cellBox.x);
  expect(box.x + box.width).toBeLessThanOrEqual((await textLeft(page, 'Budget')) + 0.5);
  expect(await textLeft(page, 'Budget')).toBeGreaterThan(left);
  // The caret skips them; Backspace at the text removes the last.
  await page.keyboard.press(LINE_START);
  await page.keyboard.press('Backspace');
  await expect(symbols.locator('.pm-symbol')).toHaveText(['★']);
  // The slash menu offers Symbol in a cell.
  await page.keyboard.press('Tab');
  await page.keyboard.type('Ryan /symbol');
  await page.keyboard.press('Enter');
  const picker = page.getByRole('menu', { name: 'Symbols' });
  await expect(picker).toBeVisible();
  await picker.getByRole('menuitemcheckbox', { name: /💡/ }).click();
  await expect(body(page).locator('td').nth(1).locator('.pm-symbol')).toHaveText(['💡']);
  // GFM cells are inline only: the symbols are the cell's leading text.
  await expectMarkdown(page, '| ★ Budget | 💡 Ryan |');
  expect(errors).toEqual([]);
});

test('T52, A-NEW-3: the gutter holds three symbols at every width, past that two and "+N"', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const id = await newNote(page, `Symbol overflow ${RUN}`);
  await page.keyboard.type('Plain line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Three symbols');
  for (const slot of [4, 5, 6]) await page.keyboard.press(SYMBOL(slot));
  const line = body(page).locator('p').nth(1);
  const margin = line.getByTestId('line-symbols');
  await expect(margin.locator('.pm-symbol')).toHaveText(['!', '💡', '→']);
  await expect(body(page)).toHaveAttribute('data-symbol-slots', '3');
  /** All three show, in the gutter: not over the text, which starts where a plain line's does. */
  const expectAllInGutter = async () => {
    await expect(margin.locator('.pm-symbol:visible')).toHaveCount(3);
    await expect(margin.locator('.pm-symbols-more')).toHaveCount(0);
    await expect(margin).not.toHaveClass(/\bis-badge\b/);
    const column = (await body(page).boundingBox())!;
    const box = (await margin.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(column.x + 1);
    expect(
      Math.abs((await textLeft(page, 'Three symbols')) - (await textLeft(page, 'Plain line'))),
    ).toBeLessThan(0.5);
    await expectHandleClear(page, line, margin);
  };
  // Beside the side panel (open, the default) and without it.
  const columns = page.locator('.note-columns');
  await expect(columns).toHaveAttribute('data-panel', 'open');
  await expectAllInGutter();
  await page.getByTestId('note-panel-close').click();
  await expect(columns).toHaveAttribute('data-panel', 'closed');
  await expectAllInGutter();

  const toggle = page.getByTestId('toggle-full-width');
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
  try {
    await toggle.click();
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-width', 'full');
    // Full width: the gutter still holds the three, inside the pane (A969 drew one and a badge).
    await expectAllInGutter();
    const pane = (await page
      .locator('.note-main', { has: page.getByTestId('note-body') })
      .boundingBox())!;
    expect((await margin.boundingBox())!.x).toBeGreaterThanOrEqual(pane.x);

    // A fourth: the first two and "+2", every symbol named and in the popover.
    await line.click();
    await page.keyboard.press(SYMBOL(2));
    await expect(margin.locator('.pm-symbol')).toHaveText(['★', '!', '💡', '→']);
    await expect(margin.locator('.pm-symbol:visible')).toHaveText(['★', '!']);
    const more = margin.locator('.pm-symbols-more');
    await expect(more).toHaveText('+2');
    await expect(body(page)).toHaveAttribute('data-symbol-slots', '3');
    await expect(margin.locator('.pm-symbols-label')).toHaveText(
      /★ Important ! Follow-up 💡 Idea → Next/,
    );
    const popover = margin.locator('.pm-symbols-popover');
    await expect(popover).toBeHidden();
    await margin.hover();
    await expect(popover).toBeVisible();
    await expect(popover.locator('.pm-symbols-popover-glyph')).toHaveText(['★', '!', '💡', '→']);
    // A click still opens the picker for the line.
    await margin.click();
    await expect(page.getByRole('menu', { name: 'Symbols' })).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    // Shared workspace: leave full width off for the other specs.
    if (!(await toggle.isVisible())) await page.goto(`/notes/${id}`);
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => storedSetting(page, 'note.fullWidth'), { timeout: 10_000 }).toBe(false);
  }

  // A phone's width: the same gutter, three slots at most.
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(margin.locator('.pm-symbol:visible')).toHaveText(['★', '!']);
  await expect(margin.locator('.pm-symbols-more')).toHaveText('+2');
  const column = (await body(page).boundingBox())!;
  expect((await margin.boundingBox())!.x + (await margin.boundingBox())!.width).toBeLessThanOrEqual(
    column.x + 1,
  );
  expect((await margin.boundingBox())!.x).toBeGreaterThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('A-NEW-1, A-NEW-2: a numbered item takes a box and a star, and a line is struck through', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Stacked symbols ${RUN}`);
  await page.keyboard.type('1. Call the bank');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Book the train');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Cancelled meeting');
  const plainLeft = await textLeft(page, 'Cancelled meeting');
  await expect(body(page)).not.toHaveAttribute('data-symbol-slots');

  // On the first item: ★, then the Checkbox. The box goes first (slot 1), the number stays,
  // and the other item is untouched.
  await body(page).getByText('Call the bank').click();
  await page.keyboard.press(SYMBOL(2));
  await page.keyboard.press(SYMBOL(1));
  const items = body(page).locator('ol > li');
  await expect(items).toHaveCount(2);
  const first = items.first().getByTestId('line-symbols');
  await expect(first.locator('.pm-symbol')).toHaveText(['☐', '★']);
  await expect(items.nth(1).getByTestId('line-symbols')).toHaveCount(0);
  await expect(body(page).locator('li[data-checked]')).toHaveCount(0);
  await expect(body(page)).toHaveAttribute('data-symbol-slots', '2');
  // ⌃1 again ticks it, the number kept; a click on the box unticks it.
  await page.keyboard.press(SYMBOL(1));
  await expect(first.locator('.pm-symbol')).toHaveText(['☑', '★']);
  await expect(body(page).locator('ol > li')).toHaveCount(2);
  await first.locator('.pm-symbol[data-box]').click();
  await expect(first.locator('.pm-symbol')).toHaveText(['☐', '★']);

  // Strikethrough on the plain line: its text struck through, its ⊘ in the gutter.
  await body(page).getByText('Cancelled meeting').click();
  await page.keyboard.press(SYMBOL(7));
  const struck = body(page).locator('.pm-symbol-struck');
  await expect(struck).toHaveText('Cancelled meeting');
  await expect(struck).toHaveCSS('text-decoration-line', 'line-through');
  const plain = body(page).locator('p', { hasText: 'Cancelled meeting' });
  await expect(plain.getByTestId('line-symbols').locator('.pm-symbol')).toHaveText(['⊘']);
  // Every line's text starts at the same place, in a column moved right by the gutter.
  expect(await textLeft(page, 'Cancelled meeting')).toBeGreaterThan(plainLeft);
  const symbolsBox = (await first.boundingBox())!;
  expect(symbolsBox.x + symbolsBox.width).toBeLessThanOrEqual(
    (await body(page).boundingBox())!.x + 1,
  );

  await expectMarkdown(page, '1. ☐ ★ Call the bank', '2. Book the train', '⊘ Cancelled meeting');

  // Off again: no symbols, no gutter.
  await body(page).getByText('Cancelled meeting').click();
  await page.keyboard.press(SYMBOL(7));
  await expect(struck).toHaveCount(0);
  await body(page).getByText('Call the bank').click();
  // ☐ → ☑ → none, then the ★ off.
  await page.keyboard.press(SYMBOL(1));
  await expect(first.locator('.pm-symbol')).toHaveText(['☑', '★']);
  await page.keyboard.press(SYMBOL(1));
  await expect(first.locator('.pm-symbol')).toHaveText(['★']);
  await page.keyboard.press(SYMBOL(2));
  await expect(body(page).getByTestId('line-symbols')).toHaveCount(0);
  await expect(body(page)).not.toHaveAttribute('data-symbol-slots');
  expect(Math.abs((await textLeft(page, 'Cancelled meeting')) - plainLeft)).toBeLessThan(0.5);
  expect(errors).toEqual([]);
});
