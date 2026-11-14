import { expect, test, type Page } from './fixtures';

// Ryan's feedback of 6 Nov 2026 ("Quanta Penmoss Feedback 3", Quanta), T66, in the web app (the
// Mac app runs the same page): the note's scrollbar at the text's edge (item 1, A1132); search by
// notebook (2, A1127) and inside words (3, A1126); the markdown source edited in place (4,
// A1133); the title bar's buttons chosen in Display (5, A1134); an arrow over the bars (6,
// A1129); icons on every toolbar button (7, A1131); flush rows (8, A1135); where settings are
// kept (9, A1136); settings copied between notebooks (10, A1137); the caret centred in its
// room (11, A1130); the repository a link and no Private line (12, A1128).

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const LONG = Array.from({ length: 80 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n\n');

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

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

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

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} has no box`);
  return found;
};

test('1, 6: the note scrolls in its own column, left of the panel; the bars show an arrow', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/');
  await openNote(page, 'Long');
  // The panel shows on a wide window; opened if it was closed here before.
  if ((await page.locator('.note-side').count()) === 0) {
    await page.getByRole('tab', { name: 'Metadata' }).click();
  }
  await expect(page.locator('.note-side')).toBeVisible();
  const scroller = page.getByTestId('note-scroll');
  const scroll = await box(page, '[data-testid="note-scroll"]');
  const side = await box(page, '.note-side');
  // The text's scroller ends where the panel starts: its scrollbar is at the text's edge.
  expect(scroll.x + scroll.width).toBeLessThanOrEqual(side.x + 1);
  expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  // The page itself does not scroll: only the text does.
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight),
  ).toBe(true);
  await scroller.evaluate((element) => (element.scrollTop = 600));
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(600);
  expect((await box(page, '.note-side')).y).toBe(side.y);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/scroll.png` });

  // Item 6: an arrow over the title bar and the status bar, not the I-beam.
  for (const selector of ['.note-top', '.note-top .crumbs', '.status-bar']) {
    expect(
      await page
        .locator(selector)
        .first()
        .evaluate((element) => getComputedStyle(element).cursor),
    ).toBe('default');
  }
  expect(errors).toEqual([]);
});

test('2, 3: search finds words inside words, and filters by notebook before folder', async ({
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

test('4: the markdown source’s body is edited in place; its frontmatter is not', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await openNote(page, 'Source');
  await page.keyboard.press('ControlOrMeta+Shift+KeyM');
  const source = page.getByTestId('note-markdown');
  await expect(source).toContainText('title: Source');
  const front = page.getByTestId('note-markdown-frontmatter');
  const body = page.getByTestId('note-markdown-body');
  await expect(front).toContainText('title: Source');
  await expect(front).not.toHaveAttribute('contenteditable', /true|plaintext-only/);
  await expect(body).toHaveAttribute('contenteditable', 'plaintext-only');
  await expect(body).toHaveText('## Plan\n\nFirst line.\n');

  // Typed at the body's end: a new paragraph with bold text, applied after a pause.
  await body.click();
  await body.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.keyboard.type('\n\nSecond **bold** line.');
  await expect(body).toContainText('Second **bold** line.');
  // Back in the editor, the note has it.
  await page.keyboard.press('ControlOrMeta+Shift+KeyM');
  const editor = page.locator('.note-body .ProseMirror');
  await expect(editor.locator('p strong')).toHaveText('bold');
  await expect(editor.locator('p').last()).toHaveText('Second bold line.');
  await expect(editor.locator('h2')).toHaveText('Plan');

  // Edited again and left by a click elsewhere: applied at once.
  await page.keyboard.press('ControlOrMeta+Shift+KeyM');
  await body.click();
  // The caret at the start (⌘↑ on a Mac, Ctrl+Home elsewhere): set directly.
  await body.evaluate((element) => {
    const range = document.createRange();
    range.setStart(element.firstChild!, 0);
    range.collapse(true);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.keyboard.type('# Top\n\n');
  await page.getByTestId('note-markdown-hint').click();
  await expect(body).toHaveText(/^# Top\n\n## Plan/);
  if (SHOTS) await page.locator('.note-source').screenshot({ path: `${SHOTS}/source.png` });
  await page.keyboard.press('ControlOrMeta+Shift+KeyM');
  await expect(editor.locator('h1')).toHaveText('Top');
  // The title stays the note's own: the frontmatter was not touched.
  await expect(page.getByTestId('note-title')).toHaveValue('Source');
  expect(errors).toEqual([]);
});

test('5: the title bar’s buttons are chosen in Display, each also in ⋯', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await openNote(page, 'Source');
  const bar = page.locator('.note-top .note-actions');
  // As before: Full Width and Copy Agent Reference, then ⋯.
  await expect(bar.locator('[data-note-bar]')).toHaveCount(2);
  await expect(bar.getByTestId('toggle-full-width')).toBeVisible();
  await expect(bar.getByTestId('copy-agent-reference')).toBeVisible();
  // Every button the bar can show is in ⋯, Full Width among them.
  await page.getByTestId('note-menu').click();
  const menu = page.getByRole('menu');
  for (const name of ['Full Width', 'Markdown Source']) {
    await expect(menu.getByRole('menuitemcheckbox', { name })).toHaveCount(1);
  }
  for (const name of [
    'Copy Note as Markdown',
    'Copy Note as Rich Text',
    'Copy Agent Reference',
    'Pin to Quick Access',
    'Open in New Window',
    'Move to Folder…',
    'Move to Trash',
  ]) {
    await expect(menu.getByRole('menuitem', { name })).toHaveCount(1);
  }
  await page.keyboard.press('Escape');

  await page.goto('/settings/display');
  const settings = page.getByTestId('note-bar-settings');
  await expect(settings.getByRole('checkbox')).toHaveCount(9);
  await settings.getByTestId('display-note-bar-copyAgentReference').uncheck();
  await settings.getByTestId('display-note-bar-toggleSource').check();
  await settings.getByTestId('display-note-bar-pinQuickAccess').check();
  if (SHOTS) await settings.screenshot({ path: `${SHOTS}/display-note-bar.png` });
  await page.goBack();
  await expect(page.getByTestId('note-title')).toHaveValue('Source');
  await expect(bar.locator('[data-note-bar]')).toHaveCount(3);
  await expect(bar.getByTestId('copy-agent-reference')).toHaveCount(0);
  // A chosen button runs its command and shows its state.
  const markdown = bar.getByTestId('note-bar-toggleSource');
  await markdown.click();
  await expect(markdown).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('note-markdown')).toBeVisible();
  await markdown.click();
  await bar.getByTestId('note-bar-pinQuickAccess').click();
  await expect(bar.getByTestId('note-bar-pinQuickAccess')).toHaveAttribute('aria-pressed', 'true');
  if (SHOTS) await page.locator('.note-top').screenshot({ path: `${SHOTS}/note-bar.png` });
  expect(errors).toEqual([]);
});

test('7: every button of the selection toolbar is an icon', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await openNote(page, 'Source');
  await page.locator('.note-body .ProseMirror p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  const toolbar = page.getByRole('toolbar', { name: 'Format selection' });
  await expect(toolbar).toBeVisible();
  const buttons = toolbar.locator('button:visible');
  const count = await buttons.count();
  expect(count).toBeGreaterThan(6);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    // An icon, and no words on the button itself: its name is its label.
    await expect(button.locator('svg').first()).toBeVisible();
    expect(((await button.innerText()) ?? '').replace(/[¶\s]/g, '')).toMatch(/^[A-Za-z0-9]?$/);
    await expect(button).toHaveAttribute('aria-label', /.+/);
  }
  if (SHOTS) await toolbar.screenshot({ path: `${SHOTS}/toolbar.png` });
  expect(errors).toEqual([]);
});

test('8, 11: the sidebar’s rows and the note’s buttons are flush; the caret is centred', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/');
  await openNote(page, 'Source');
  // The Mac app's compact title bar, as mac-window.ts sets it.
  await page.evaluate(() => (document.documentElement.dataset['titlebar'] = 'compact'));
  const sidebar = await box(page, '.sidebar');
  const sbHead = await box(page, '.sb-head');
  const pair = await box(page, '.sb-head .history-pair');
  const collapse = await box(page, '.sb-head .sb-collapse');
  // Back and Forward and Collapse as tall as the row, Collapse at its end.
  for (const button of [pair, collapse]) {
    expect(button.y).toBe(sbHead.y);
    expect(Math.round(button.height)).toBe(Math.round(sbHead.height) - 1);
  }
  expect(Math.round(collapse.x + collapse.width)).toBe(Math.round(sidebar.x + sidebar.width) - 1);
  // A hairline after the lights: Back's left border.
  expect(
    await page
      .locator('.sb-head .history-pair')
      .evaluate((element) => getComputedStyle(element).borderLeftWidth),
  ).toBe('1px');
  // The shortcuts from edge to edge, no gap above or between them.
  const shortcuts = page.locator('.sb-shortcuts .sb-shortcut');
  const first = (await shortcuts.first().boundingBox())!;
  const last = (await shortcuts.last().boundingBox())!;
  expect(Math.round(first.x)).toBe(Math.round(sidebar.x));
  expect(Math.round(first.y)).toBe(Math.round(sbHead.y + sbHead.height));
  expect(Math.round(last.x + last.width)).toBe(Math.round(sidebar.x + sidebar.width) - 1);
  // The note's title bar: its buttons as tall as the bar, the last at the window's edge.
  const top = await box(page, '.note-top');
  const menu = await box(page, '.note-top [data-testid="note-menu"]');
  expect(Math.round(menu.x + menu.width)).toBe(Math.round(top.x + top.width));
  expect(Math.round(menu.height)).toBe(Math.round(top.height) - 1);
  // The panel's tabs: from the top of their strip, no gap between them.
  const rail = page.locator('.note-rail-icons .note-rail-btn');
  const tab0 = (await rail.nth(0).boundingBox())!;
  const tab1 = (await rail.nth(1).boundingBox())!;
  expect(Math.round(tab1.y)).toBe(Math.round(tab0.y + tab0.height));
  expect(Math.round(tab0.y)).toBe(Math.round((await box(page, '.note-rail-icons')).y));
  if (SHOTS) {
    await page.screenshot({
      path: `${SHOTS}/flush.png`,
      clip: { x: 0, y: 0, width: 1400, height: 160 },
    });
  }

  // Item 11: a section's caret halfway between the window's edge and its title's text.
  await page.evaluate(() => delete document.documentElement.dataset['titlebar']);
  // Every section title's caret, and a folder's, on one column.
  const head = page.locator('.sb-part-head').first();
  const caret = (await head.locator('.sb-section-toggle svg').first().boundingBox())!;
  const name = (await head.locator('.sb-section-name').first().boundingBox())!;
  const before = caret.x - sidebar.x;
  const after = name.x - (caret.x + caret.width);
  const folderCaret = (await page
    .locator('.sidebar .tree-row')
    .filter({ hasText: 'Miscellaneous' })
    .first()
    .locator('.twisty svg')
    .boundingBox())!;
  expect(Math.round(folderCaret.x)).toBe(Math.round(caret.x));
  expect(Math.abs(before - after)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('9, 10, 12: Settings name the primary notebook; settings copy to another notebook', async ({
  page,
  host,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await openNote(page, 'Source');
  await host.seed({ name: 'Work', notes: [{ title: 'Parser' }] });
  await expect(section(page, 'Work')).toBeVisible({ timeout: 40_000 });
  await page.goto('/settings/display');
  const home = page.getByTestId('settings-home');
  await expect(home).toHaveText('Settings are synced through your primary notebook, Quanta.');
  if (SHOTS)
    await page.locator('.settings-title').screenshot({ path: `${SHOTS}/settings-home.png` });

  // A setting in the primary notebook, copied into Work from Work's page.
  await page.getByTestId('display-note-bar-delete').check();
  await page.getByTestId('settings-home-link').click();
  await expect(page.getByTestId('git-primary-state')).toBeVisible();
  // Item 12: no Private line.
  await expect(page.getByText('Private', { exact: true })).toHaveCount(0);
  await page.goto('/settings/git-notebooks');
  await page.getByTestId('git-notebook-row').filter({ hasText: 'Work' }).click();
  const copy = page.getByTestId('git-settings-copy');
  await copy.getByTestId('git-copy-settings').click();
  await expect(copy.getByTestId('git-copy-settings-done')).toHaveText(
    'Copied Quanta’s settings to Work.',
  );
  await copy.getByTestId('git-copy-settings').click();
  await expect(copy.getByTestId('git-copy-settings-done')).toHaveText(
    'Work already had these settings.',
  );
  if (SHOTS)
    await page.getByTestId('git-primary').screenshot({ path: `${SHOTS}/copy-settings.png` });
  // Work made primary: it reads the same, so the bar keeps Move to Trash.
  await page.getByTestId('git-make-primary').click();
  await expect(page.getByTestId('git-primary-state')).toBeVisible();
  await expect(page.getByTestId('settings-home')).toHaveText(
    'Settings are synced through your primary notebook, Work.',
  );
  await page.goto('/settings/display');
  await expect(page.getByTestId('display-note-bar-delete')).toBeChecked();
  expect(errors).toEqual([]);
});
