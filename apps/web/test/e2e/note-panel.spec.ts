import { expect, test, type Page } from './fixtures';
import { COMMENTS_PANEL, INFO_PANEL, NEW_NOTE, VERSION_HISTORY } from './keys';
import { storedDocumentText } from './stored';

// T51 items 5–7 (A936, A937): the note's side panel as four icon tabs (Metadata, Comments,
// History, Local Graph), the last one remembered; each
// command opening its tab or closing the panel; Version History and the Local Graph inside it.
// T53 item 9 (A985, superseding T52 item 6's Hidden, Compact and Expanded): the four tabs' icons
// always run down the note's right edge as vertical tabs; the panel is open on one or closed, per
// note, with a default in Settings → Appearance; in a narrow pane it lies over the text.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const tab = (page: Page, name: 'info' | 'comments' | 'history' | 'graph') =>
  page.getByTestId(`note-tab-${name}`);
const side = (page: Page) => page.locator('aside.note-side');
const rail = (page: Page) => page.getByTestId('note-rail');
const columns = (page: Page) => page.locator('.note-columns');

async function newNote(page: Page, title: string, text: string): Promise<string> {
  await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();
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
 * Double-clicks `word` itself in the note's body. A locator's centre is its whole paragraph's,
 * which on a short line is empty space past the text, where a double click selects nothing.
 */
async function doubleClickWord(page: Page, word: string): Promise<void> {
  const box = await body(page).evaluate((root, wanted) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(wanted) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    throw new Error(`no "${wanted}"`);
  }, word);
  await page.mouse.dblclick(box.x, box.y);
}

/** Types a wikilink to `title` and picks it from the completion (as graph.spec.ts). */
async function linkTo(page: Page, title: string) {
  const menu = page.getByTestId('link-menu');
  await page.keyboard.type(`[[${title}`);
  await expect(menu.getByRole('option').first()).toContainText(title);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('four vertical tabs down the note’s edge, tooltips, ↑ and ↓ between them, the last one remembered', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Tabs ${RUN}`, 'Text beside the panel.');
  const tablist = page.getByRole('tablist', { name: 'Note panel' });
  await expect(tablist).toBeVisible();
  await expect(tablist).toHaveAttribute('aria-orientation', 'vertical');
  await expect(tablist.getByRole('tab')).toHaveCount(4);
  for (const [id, name] of [
    ['info', 'Metadata'],
    ['comments', 'Comments'],
    ['history', 'History'],
    ['graph', 'Local Graph'],
  ] as const) {
    await expect(tab(page, id)).toHaveAccessibleName(name);
  }
  // Down the note pane's right edge, one above the other.
  const pane = (await page.locator('.note-main').boundingBox())!;
  const strip = (await rail(page).boundingBox())!;
  expect(Math.abs(strip.x + strip.width - (pane.x + pane.width))).toBeLessThanOrEqual(16);
  const infoBox = (await tab(page, 'info').boundingBox())!;
  const commentsBox = (await tab(page, 'comments').boundingBox())!;
  expect(commentsBox.y).toBeGreaterThan(infoBox.y);
  expect(Math.abs(commentsBox.x - infoBox.x)).toBeLessThanOrEqual(1);

  // Open on Metadata by default on a wide window: beside the strip, named, with Close.
  await expect(columns(page)).toHaveAttribute('data-panel', 'open');
  await expect(tab(page, 'info')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', /-info$/);
  await expect(page.getByRole('complementary', { name: 'Metadata' })).toBeVisible();
  // The head names the tab (its own heading stays for screen readers only).
  await expect(side(page).locator('.note-side-head h2')).toHaveText('Metadata');
  await expect(page.getByTestId('note-panel-close')).toBeVisible();
  const panelBox = (await side(page).boundingBox())!;
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(strip.x + 1);

  // The tooltip names the tab and its shortcut; the open one's says it closes.
  await tab(page, 'history').hover();
  await expect(page.getByTestId('tooltip')).toHaveText(/^History \(.+\)$/);
  await page.mouse.move(0, 0);
  await tab(page, 'info').hover();
  await expect(page.getByTestId('tooltip')).toHaveText(/^Close Metadata \(.+\)$/);

  // ↓ and ↑ (the strip runs down) move between the tabs, and show each; ← and → do not.
  await tab(page, 'info').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'info')).toBeFocused();
  await expect(tab(page, 'info')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(tab(page, 'comments')).toBeFocused();
  await expect(tab(page, 'comments')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('comments-panel')).toBeVisible();
  await page.keyboard.press('End');
  await expect(tab(page, 'graph')).toBeFocused();
  await expect(page.getByTestId('note-graph')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(tab(page, 'history')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('history-panel')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(tab(page, 'history')).toBeFocused();
  // Beside the note, the panel is one width for every tab, so nothing moves (A936).
  const width = (await side(page).boundingBox())!.width;
  await page.keyboard.press('Home');
  await expect(tab(page, 'info')).toHaveAttribute('aria-selected', 'true');
  expect((await side(page).boundingBox())!.width).toBe(width);
  // From the first, ↑ goes round to the last.
  await page.keyboard.press('ArrowUp');
  await expect(tab(page, 'graph')).toBeFocused();
  await expect(tab(page, 'graph')).toHaveAttribute('aria-selected', 'true');

  // Remembered on this device: a reload shows the last tab.
  await tab(page, 'comments').click();
  await page.reload();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(tab(page, 'comments')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('complementary', { name: 'Comments' })).toBeVisible();

  // Close closes the panel; the strip stays, no tab selected; a tab's icon opens it on that tab.
  await page.getByTestId('note-panel-close').click();
  await expect(side(page)).toHaveCount(0);
  await expect(columns(page)).toHaveAttribute('data-panel', 'closed');
  await expect(tablist).toBeVisible();
  await expect(tablist.getByRole('tab', { selected: true })).toHaveCount(0);
  await tab(page, 'history').click();
  await expect(tab(page, 'history')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('complementary', { name: 'History' })).toBeVisible();
  // Another tab's icon switches it; the open tab's icon closes it.
  await tab(page, 'comments').click();
  await expect(tab(page, 'comments')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('complementary', { name: 'Comments' })).toBeVisible();
  await tab(page, 'comments').click();
  await expect(side(page)).toHaveCount(0);
  await expect(columns(page)).toHaveAttribute('data-panel', 'closed');
  expect(errors).toEqual([]);
});

test('commands open a tab and focus its icon; Escape closes the panel back to the icon', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Panel ${RUN}`, 'Words beside the panel.');
  // The note's bar has no panel buttons of its own any more: the strip is the way in.
  await expect(page.locator('.note-top').getByRole('button', { name: /^Note Panel/ })).toHaveCount(
    0,
  );
  await expect(page.locator('.note-top').getByRole('button', { name: /^Comments/ })).toHaveCount(0);
  // Open by default on a wide window; History from the ⋯ menu.
  await page.getByTestId('note-tab-history').click();
  await expect(tab(page, 'history')).toHaveAttribute('aria-selected', 'true');
  // A command that opened the panel puts focus on its tab, for a screen reader to name.
  await expect(tab(page, 'history')).toBeFocused();

  // Escape in the panel closes it, and focus goes back to the tab's icon.
  await page.getByTestId('note-panel-close').focus();
  await expect(page.getByTestId('note-panel-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(side(page)).toHaveCount(0);
  await expect(tab(page, 'history')).toBeFocused();
  await expect(rail(page)).toBeVisible();

  // From the keyboard, in the note's body too: the shortcut's tab opens and takes focus. (Until
  // A951 a Mac's ⌘⌥⇧C there was Copy as Rich Text's, which the editor's scope took first.)
  await body(page).click();
  await page.keyboard.press(COMMENTS_PANEL);
  await expect(tab(page, 'comments')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'comments')).toBeFocused();
  // The palette's Show or Hide the Note Panel closes it, and opens it again on the last tab.
  const palette = async () => {
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.keyboard.type('Show or Hide the Note Panel');
    await page.keyboard.press('Enter');
  };
  await palette();
  await expect(side(page)).toHaveCount(0);
  await palette();
  await expect(tab(page, 'comments')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('complementary', { name: 'Comments' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('each note remembers its panel open or closed; T52’s modes read as open or closed', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const id = await newNote(page, `Closed ${RUN}`, 'Words beside the strip.');
  await expect(side(page)).toBeVisible();
  await tab(page, 'info').click();
  await expect(side(page)).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (note) =>
          (JSON.parse(localStorage.getItem('penmoss.notePanelModes') ?? '[]') as string[][]).find(
            ([each]) => each === note,
          )?.[1],
        id,
      ),
    )
    .toBe('closed');

  // Remembered for this note across a reload; another takes the default (open).
  await page.reload();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(columns(page)).toHaveAttribute('data-panel', 'closed');
  await expect(rail(page)).toBeVisible();
  await expect(side(page)).toHaveCount(0);
  const other = await newNote(page, `Other ${RUN}`, 'Words beside the panel.');
  await expect(side(page)).toBeVisible();
  await page.goto(`/notes/${id}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(side(page)).toHaveCount(0);
  await expect(rail(page)).toBeVisible();

  // A command opens it, and that is remembered too.
  await body(page).click();
  await page.keyboard.press(VERSION_HISTORY);
  await expect(tab(page, 'history')).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(side(page)).toBeVisible();

  // T52's stored modes: Expanded reads as open, Hidden and Compact as closed.
  for (const [stored, shown] of [
    ['compact', 'closed'],
    ['expanded', 'open'],
    ['hidden', 'closed'],
  ] as const) {
    await page.evaluate(
      ([note, mode]) =>
        localStorage.setItem('penmoss.notePanelModes', JSON.stringify([[note, mode]])),
      [other, stored] as const,
    );
    await page.goto(`/notes/${other}`);
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
    await expect(columns(page)).toHaveAttribute('data-panel', shown);
    await expect(rail(page)).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('the default from Settings → Appearance; in a narrow pane the panel lies over the text', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/settings/appearance');
  const setting = page.getByTestId('note-panel-setting');
  await expect(setting.getByRole('radio')).toHaveCount(2);
  await expect(setting.getByRole('radio', { name: 'Open' })).toBeChecked();
  await setting.getByText('Closed', { exact: true }).click();
  await expect(setting.getByRole('radio', { name: 'Closed' })).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('penmoss.notePanelMode'))).toBe('closed');
  await page.goto('/');
  await newNote(page, `Default ${RUN}`, 'Words beside the strip.');
  await expect(rail(page)).toBeVisible();
  await expect(columns(page)).toHaveAttribute('data-panel', 'closed');
  await expect(side(page)).toHaveCount(0);

  await page.goto('/settings/appearance');
  await setting.getByText('Open', { exact: true }).click();
  await expect(setting.getByRole('radio', { name: 'Open' })).toBeChecked();
  await page.goto('/');
  await newNote(page, `Narrow ${RUN}`, 'Words under the panel.');
  await expect(side(page)).toBeVisible();
  await expect(columns(page)).not.toHaveAttribute('data-over', /.*/);
  // Beside the text in a wide pane: the panel starts where the text column ends.
  const text = page.locator('.note-scroll > .doc:not([hidden])');
  const beside = (await side(page).boundingBox())!;
  const column = (await text.boundingBox())!;
  expect(beside.x).toBeGreaterThanOrEqual(column.x + column.width - 1);

  // A pane under 60rem is too narrow for both: the panel lies over the end of the text, the
  // strip still beside it, and nothing below the note.
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(columns(page)).toHaveAttribute('data-over', '');
  await expect(side(page)).toBeVisible();
  await expect(rail(page)).toBeVisible();
  const over = (await side(page).boundingBox())!;
  const under = (await text.boundingBox())!;
  const strip = (await rail(page).boundingBox())!;
  expect(over.x).toBeLessThan(under.x + under.width);
  expect(over.x + over.width).toBeLessThanOrEqual(strip.x + 1);
  expect(over.y).toBeLessThan(under.y + under.height);
  // The tab's icons still work over it.
  await tab(page, 'history').click();
  await expect(page.getByRole('complementary', { name: 'History' })).toBeVisible();
  // The same window with the sidebar collapsed has the room.
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
  await expect(columns(page)).not.toHaveAttribute('data-over', /.*/);
  await expect(side(page)).toBeVisible();
  await page.getByTestId('toggle-sidebar').click();
  await expect(columns(page)).toHaveAttribute('data-over', '');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(columns(page)).not.toHaveAttribute('data-over', /.*/);
  await expect(side(page)).toBeVisible();
  expect(errors).toEqual([]);
});

test('each command opens its tab, or closes the panel when its tab shows', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Commands ${RUN}`, 'Some words.');
  await body(page).click();

  await page.keyboard.press(VERSION_HISTORY);
  await expect(tab(page, 'history')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press(COMMENTS_PANEL);
  await expect(tab(page, 'comments')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press(COMMENTS_PANEL);
  await expect(side(page)).toHaveCount(0);
  await page.keyboard.press(INFO_PANEL);
  await expect(tab(page, 'info')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press(INFO_PANEL);
  await expect(side(page)).toHaveCount(0);

  // The ⋯ menu leaves the tabs and Add Note Comment to the strip and the Comments tab (A991).
  await page.getByTestId('note-tab-graph').click();
  await expect(tab(page, 'graph')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('note-menu').click();
  await expect(page.getByTestId('toggle-markdown')).toBeVisible();
  for (const command of [
    'note.backlinks',
    'note.comments',
    'note.addNoteComment',
    'note.history',
    'note.localGraph',
  ]) {
    await expect(page.locator(`.menu [data-command="${command}"]`)).toHaveCount(0);
  }
  await page.keyboard.press('Escape');
  await page.getByTestId('note-tab-info').click();
  await expect(tab(page, 'info')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('note-tab-info').click();
  await expect(side(page)).toHaveCount(0);

  // The palette's Local Graph too.
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.keyboard.type('Local Graph');
  await page.keyboard.press('Enter');
  await expect(tab(page, 'graph')).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('the Comments tab’s icon carries the open threads’ count', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Bar ${RUN}`, 'A passage to talk about.');
  const button = tab(page, 'comments');
  await expect(button).toBeVisible();
  await expect(button).toHaveAccessibleName('Comments');
  // Not in the note's bar any more: only in the strip.
  await expect(page.locator('.note-top').getByTestId('comments-count')).toHaveCount(0);
  await expect(page.getByTestId('comments-count')).toHaveCount(0);
  await button.click();
  await expect(button).toHaveAttribute('aria-selected', 'true');

  // A thread: the count shows on the tab's icon.
  await doubleClickWord(page, 'passage');
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'Comment' }).click();
  await page.getByTestId('comment-new').fill(`Why ${RUN}?`);
  await page.getByTestId('comment-new-send').click();
  await expect(button.getByTestId('comments-count')).toHaveText('1');
  await expect(page.getByTestId('comments-count')).toHaveCount(1);
  await expect(button).toHaveAccessibleName('Comments, 1 open');

  // It closes the panel while Comments shows; the count stays on the icon.
  await button.click();
  await expect(side(page)).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-selected', 'false');
  await expect(button.getByTestId('comments-count')).toHaveText('1');
  expect(errors).toEqual([]);
});

test('Version History in the panel: save, pick a version, see its changes', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const id = await newNote(page, `History ${RUN}`, 'First words');
  // Sync Now commits what this device stored (A858): the words first.
  await expect.poll(() => storedDocumentText(page, id)).toContain('First words');
  await page.getByTestId('note-tab-history').click();
  const history = side(page).getByTestId('history-panel');
  await expect(history).toBeVisible();
  // Not an overlay: the note stays beside it, typing and all.
  await expect(history).not.toHaveCSS('position', 'fixed');
  // On a git notebook a version is a commit: Save is Sync Now (A858).
  await history.getByRole('button', { name: 'Sync Now' }).click();
  await expect(history.getByTestId('history-status')).toContainText('Saved a version', {
    timeout: 40_000,
  });
  const first = history.getByRole('list', { name: 'Versions' }).getByRole('button').first();
  await first.click();
  await expect(history.getByTestId('history-diff')).toContainText('First words');
  await body(page).click();
  await page.keyboard.type(' and more');
  await expect(body(page)).toContainText('First words and more');
  await expect(history).toBeVisible();
  expect(errors).toEqual([]);
});

test('Local Graph in the panel: the neighbourhood by depth, a click opens a note, Open Full Graph', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const far = `Far ${RUN}`;
  const near = `Near ${RUN}`;
  const farId = await newNote(page, far, 'The end of the line.');
  await newNote(page, near, 'Next to ');
  await linkTo(page, far);
  const centre = await newNote(page, `Centre ${RUN}`, 'Linked to ');
  await linkTo(page, near);

  await page.getByTestId('note-tab-graph').click();
  const graph = page.getByTestId('note-graph');
  await expect(graph.getByTestId('graph-canvas')).toBeVisible();
  // Two links out by default: Near and Far.
  await expect(graph.getByTestId('note-graph-count')).toHaveText('2 notes · 2 links');
  await graph.getByTestId('note-graph-depth').selectOption('1');
  await expect(graph.getByTestId('note-graph-count')).toHaveText('1 note · 1 link');
  await graph.getByTestId('note-graph-depth').selectOption('2');

  // The keyboard opens a note from it.
  await graph.getByTestId('graph-canvas').focus();
  await page.keyboard.type(far.slice(0, 3));
  await expect(graph.getByTestId('graph-announcement')).toContainText(far);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/notes/${farId}`);
  await expect(page.getByTestId('note-title')).toHaveValue(far);
  // The tab stays, now around this note.
  await expect(page.getByTestId('note-graph')).toBeVisible();

  // Open Full Graph: the graph page around the note.
  await page.goto(`/notes/${centre}`);
  await page.getByTestId('note-graph').getByTestId('open-full-graph').click();
  await expect(page).toHaveURL(`/graph?note=${centre}&local=1`);
  await expect(page.getByTestId('graph-count')).toHaveText('3 notes · 2 links');
  expect(errors).toEqual([]);
});
