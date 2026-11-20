import { expect, type Page, test } from './fixtures';
import { COMMENTS_PANEL, INFO_PANEL, VERSION_HISTORY } from './keys';
import { storedDocumentText, storedSetting } from './stored';
import { body, collectErrors, newNote, ULID } from './support/app';
import { pushed } from './support/sync';

// T51 items 5–7 (A936, A937): the note's side panel as four icon tabs (Metadata, Comments,
// History, Local Graph), the last one remembered; each
// command opening its tab or closing the panel; Version History and the Local Graph inside it.
// T53 item 9 (A985, superseding T52 item 6's Hidden, Compact and Expanded): the four tabs' icons
// always run down the note's right edge as vertical tabs; the panel is open on one or closed, per
// note, with a default in Settings → Note; in a narrow pane it lies over the text.

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const tab = (page: Page, name: 'info' | 'comments' | 'history' | 'graph') =>
  page.getByTestId(`note-tab-${name}`);
const side = (page: Page) => page.locator('aside.note-side');
const rail = (page: Page) => page.getByTestId('note-rail');
const columns = (page: Page) => page.locator('.note-columns');

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

test.describe('in a 1440 × 900 window', () => {
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
    // The note's own (the window's tab strip has one too, PEN-140).
    await expect(page.getByTestId('note-view').getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      /-info$/,
    );
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
    // (At the tab strip's end since PEN-140, A1505.)
    const bar = page.locator('.tab-strip-end');
    await expect(bar.getByTestId('note-actions')).toBeVisible();
    await expect(bar.getByRole('button', { name: /^Note Panel/ })).toHaveCount(0);
    await expect(bar.getByRole('button', { name: /^Comments/ })).toHaveCount(0);
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

  test('the default from Settings → Note; in a narrow pane the panel lies over the text', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/settings/note');
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

    await page.goto('/settings/note');
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
    await expect(page.locator('.tab-strip-end').getByTestId('comments-count')).toHaveCount(0);
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
});

const info = (page: Page) => page.getByRole('complementary', { name: 'Metadata' });

// T41.
test('the Info panel: tags edited there, the description, details with the id, and backlinks', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const tag = `info${RUN}`;
  const id = await newNote(page, `Info ${RUN}`, `Text with an inline #${tag}x tag`);
  await expect(info(page)).toBeVisible();
  // No tags row under the title any more: the chips are in the panel.
  await expect(page.locator('.doc [data-testid="note-tags"]')).toHaveCount(0);
  const panel = info(page);
  await expect(panel.getByTestId('info-folder')).toHaveText('Top level');
  await expect(panel.getByTestId('info-created')).not.toHaveText('Unknown');
  // The frontmatter shown nowhere else, the id, is a row of Details (PEN-161).
  await expect(panel.getByTestId('info-id')).toHaveText(id);
  await expect(panel.getByTestId('ai-description')).toBeVisible();
  await expect(panel.getByTestId('backlinks')).toBeVisible();

  // A tag added in the panel lands in the frontmatter.
  await panel.getByRole('button', { name: 'Add a Tag', exact: true }).click();
  const field = panel.getByRole('combobox', { name: 'Add a tag' });
  await field.fill(tag);
  await field.press('Enter');
  await expect(panel.getByRole('button', { name: `#${tag}`, exact: true })).toBeVisible();
  await expect(panel.getByTestId('info-inline-tags')).toContainText(`#${tag}x`);

  // Its shortcut hides and shows it; Add a tag from the palette opens it with the field.
  await body(page).click();
  await page.keyboard.press(INFO_PANEL);
  await expect(info(page)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.keyboard.type('Add a tag to this note');
  await page.keyboard.press('Enter');
  await expect(info(page).getByRole('combobox', { name: 'Add a tag' })).toBeFocused();
  expect(errors).toEqual([]);
});

// T53, item 9.
test('the note panel is vertical tabs, open or closed, with no tab row; Comments is off the bar', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Panel ${RUN}`, 'Some text.');
  const rail = page.getByTestId('note-rail');
  await expect(rail.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  await expect(page.getByTestId('toggle-comments')).toHaveCount(0);

  const comments = page.getByTestId('note-tab-comments');
  // A new note opens as the last one was left: closed, or open on any tab.
  if ((await page.locator('aside.note-side').count()) > 0) {
    await page.getByTestId('note-panel-close').click();
  }
  await expect(page.locator('.note-side')).toHaveCount(0);
  await comments.click();
  const side = page.locator('aside.note-side');
  await expect(side.locator('.note-side-head h2')).toHaveText('Comments');
  // No tab row inside: the strip is the only tab list.
  await expect(side.getByRole('tablist')).toHaveCount(0);
  // The note's own (the window's tab strip is above the note, PEN-140).
  await expect(page.getByTestId('note-view').getByRole('tablist')).toHaveCount(1);
  // Beside the note, not over it, on a wide window; no dialog.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const text = (await page.locator('.note-body').boundingBox())!;
  const panel = (await side.boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(text.x + text.width - 1);
  // Another tab switches; the open one's icon closes it; Escape closes too.
  await page.getByTestId('note-tab-history').click();
  await expect(side.locator('.note-side-head h2')).toHaveText('History');
  await page.getByTestId('note-tab-history').click();
  await expect(side).toHaveCount(0);
  await page.getByTestId('note-tab-info').click();
  await expect(side).toBeVisible();
  await page.getByTestId('note-panel-close').focus();
  await page.keyboard.press('Escape');
  await expect(side).toHaveCount(0);
  await expect(page.getByTestId('note-tab-info')).toBeFocused();
  expect(errors).toEqual([]);
});
// T53, items 9, fidelity.
test('the note panel keeps one set of columns, rows and gaps on every tab', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await newNote(page, `Fidelity ${RUN}`, 'The garden plan for spring.');
  const box = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom };
      });
  const round = (n: number) => Math.round(n * 10) / 10;

  // A thread, for the count on the Comments tab's icon. Its composer's Cancel and Comment are
  // centred on one line, though one is a quiet button and shorter (A988).
  await page.getByTestId('note-body').locator('.ProseMirror p').first().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByTestId('comment-new')).toBeFocused();
  const centres = await page
    .getByTestId('comment-popover')
    .locator('.comment-composer-actions .btn')
    .evaluateAll((all) =>
      all.map((el) => {
        const b = el.getBoundingClientRect();
        return Math.round(b.y + b.height / 2);
      }),
    );
  expect(centres.length).toBeGreaterThan(1);
  expect(new Set(centres).size).toBe(1);
  await page.getByTestId('comment-new').fill('Tomatoes too?');
  await page.getByTestId('comment-new-send').click();
  await expect(page.getByTestId('comment-popover')).toHaveCount(0);
  await expect(page.getByTestId('comments-count')).toHaveText('1');
  // Pushed, so the Metadata tab's sync line does not change while it is measured.
  await pushed(page);

  // One digit's count is square, not wider than it is tall.
  const count = await box('[data-testid="comments-count"]');
  expect(count.width).toBeLessThanOrEqual(count.height + 0.5);

  // The bar's last action sits over the strip's icons, on one column.
  const rail = await page
    .locator('.note-rail-btn')
    .evaluateAll((all) =>
      all.map((el) => el.getBoundingClientRect()).map((b) => Math.round(b.x + b.width / 2)),
    );
  expect(new Set(rail).size).toBe(1);
  const last = await page
    .locator('.tab-strip-end .note-actions button')
    .last()
    .evaluate((el) => el.getBoundingClientRect().x + el.getBoundingClientRect().width / 2);
  expect(Math.abs(last - rail[0]!)).toBeLessThan(1);

  // Every tab's content starts the same distance under the head, in the same text size.
  const first = {
    // Metadata starts with its heading (layout A, PEN-161); the other tabs with their bar.
    info: '.note-side .note-info > :first-child',
    comments: '.note-side .comments-filter',
    history: '.note-side .history-scroll',
    graph: '.note-side .note-graph-bar',
  } as const;
  const starts: number[] = [];
  const sizes: string[] = [];
  for (const [tab, selector] of Object.entries(first)) {
    const button = page.getByTestId(`note-tab-${tab}`);
    if ((await button.getAttribute('aria-selected')) !== 'true') await button.click();
    await expect(page.locator(selector)).toBeVisible();
    // A git notebook's backlinks are found on this device, and its versions read from git, a
    // moment after the tab opens.
    await expect(page.locator('.note-side').getByText('Looking for links…')).toHaveCount(0);
    if (tab === 'history') {
      await expect(
        page.locator('.note-side').getByRole('list', { name: 'Versions' }),
      ).toBeVisible();
    }
    const head = await box('.note-side-head');
    starts.push(round((await box(selector)).y - head.bottom));
    sizes.push(
      await page
        .locator('.note-tabpanel > *')
        .first()
        .evaluate((el) => getComputedStyle(el).fontSize),
    );
    // Hovering the strip's icons and Close moves nothing in the panel (the graph's own drawing,
    // which settles as it runs, aside).
    const boxes = () =>
      page
        .locator('.note-side *:not(.note-graph-canvas, .note-graph-canvas *), .note-rail *')
        .evaluateAll((all) =>
          all.map((el) => {
            const b = el.getBoundingClientRect();
            return [b.x, b.y, b.width, b.height].join();
          }),
        );
    await page.mouse.move(640, 700);
    // Settled first: a git notebook's tab reads from this device and git as it opens (a version's
    // changes come a moment after its list).
    await expect
      .poll(async () => {
        const before = JSON.stringify(await boxes());
        await page.waitForTimeout(300);
        return JSON.stringify(await boxes()) === before;
      })
      .toBe(true);
    const resting = await boxes();
    for (const target of ['note-tab-info', 'note-tab-graph', 'note-panel-close']) {
      await page.getByTestId(target).hover();
      expect(await boxes(), `${tab}: ${target}`).toEqual(resting);
    }
  }
  expect(new Set(starts).size, JSON.stringify(starts)).toBe(1);
  expect(new Set(sizes).size, JSON.stringify(sizes)).toBe(1);

  // Metadata: its rows one height, the details' values on one column, and each section heading
  // (Description, Details, Backlinks) as far under what precedes it; Tags opens the panel.
  await page.getByTestId('note-tab-info').click();
  await expect(page.locator('.note-side .bl-heading')).toBeVisible();
  // Settled first, as each tab is above: its frontmatter is read a moment after the tab opens,
  // and its names' column is as wide as their monospace text, once that font has loaded.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const measure = () =>
    page.locator('.note-side .note-info').evaluate((panel) => {
      const rect = (el: Element) => el.getBoundingClientRect();
      const r = (n: number) => Math.round(n * 10) / 10;
      const heads = [...panel.querySelectorAll('.info-subheading, .bl-heading')]
        .filter((head) => !head.previousElementSibling?.classList.contains('info-heading'))
        .map((head) => {
          const block = head.classList.contains('bl-heading') ? head.closest('.backlinks')! : head;
          return r(rect(head).top - rect(block.previousElementSibling!).bottom);
        });
      return {
        heights: [...panel.querySelectorAll('.info-list dt, .info-list dd')].map((el) =>
          r(rect(el).height),
        ),
        values: [...panel.querySelectorAll('.info-list dd')].map((el) => r(rect(el).x)),
        heads,
      };
    });
  await expect
    .poll(async () => {
      const before = JSON.stringify(await measure());
      await page.waitForTimeout(300);
      return JSON.stringify(await measure()) === before;
    })
    .toBe(true);
  const info = await measure();
  expect(new Set(info.heights).size, JSON.stringify(info.heights)).toBe(1);
  expect(new Set(info.values).size, JSON.stringify(info.values)).toBe(1);
  expect(info.heads.length).toBe(3);
  expect(new Set(info.heads).size, JSON.stringify(info.heads)).toBe(1);
  expect(errors).toEqual([]);
});

const SHOTS = process.env['PENMOSS_EVIDENCE'];

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

const tree = (page: Page, name: string) =>
  section(page, name).getByRole('tree', { name: 'Folders and notes' });

async function openNote(page: Page, notebook: string, title: string): Promise<string> {
  await tree(page, notebook).getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}
test.describe('in Quanta, with two folders and two notes', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Substation', 'Geotech'],
      notes: [{ title: 'Alpha' }, { title: 'Penmoss Feedback' }],
    },
  });

  // Ryan’s feedback of 5 Nov 2026 (Personal), items 4, 5.
  test('metadata pinned under the title and in the status bar; the Metadata tab without Saved', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await openNote(page, 'Quanta', 'Alpha');
    await page.getByTestId('note-body').locator('.ProseMirror').click();
    await page.keyboard.type('Three more words');
    const bar = page.getByTestId('status-bar');
    // Unset: the counts, as before.
    await expect(bar.getByTestId('note-counts')).toContainText('3 words');
    await expect(page.getByTestId('pinned-metadata')).toHaveCount(0);

    // 5 and 4: no Saved row; Length is Words, Characters and Reading Time.
    if (!(await page.getByTestId('note-info').isVisible())) {
      await page.getByTestId('note-tab-info').click();
    }
    const details = page.getByTestId('note-details');
    for (const name of ['Words', 'Characters', 'Reading Time']) {
      await expect(details.locator('dt', { hasText: name })).toHaveCount(1);
    }
    await expect(details).not.toContainText('Saved');
    await expect(details).not.toContainText('Length');
    await expect(page.getByTestId('info-words')).toHaveText('3');

    // Settings → Note pins Edited and Tags under the title, and Edited in the status bar for
    // the counts.
    await page.goto('/settings/note');
    await page.getByTestId('metadata-title-edited').check();
    await page.getByTestId('metadata-title-tags').check();
    await page.getByTestId('metadata-status-edited').check();
    for (const field of ['words', 'characters', 'reading']) {
      await page.getByTestId(`metadata-status-${field}`).uncheck();
    }
    // The status bar offers no Tags: they are edited.
    await expect(page.getByTestId('metadata-status-tags')).toHaveCount(0);
    await expect.poll(() => storedSetting(page, 'metadata.underTitle')).toEqual(['edited', 'tags']);
    await expect.poll(() => storedSetting(page, 'metadata.statusBar')).toEqual(['edited']);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/display-metadata.png`, fullPage: true });

    await page.goto('/');
    await openNote(page, 'Quanta', 'Alpha');
    const pinned = page.getByTestId('pinned-metadata');
    await expect(pinned.locator('[data-field="edited"]')).toContainText('Edited');
    // Its tags with + under the title: a tag added there is the note's.
    await pinned.getByRole('button', { name: 'Add a Tag', exact: true }).click();
    await page.keyboard.type('pinned');
    await page.keyboard.press('Enter');
    await expect(pinned.locator('.tag-chip[data-tag="pinned"]')).toBeVisible();
    await expect(bar.getByTestId('note-counts')).toContainText('Edited');
    await expect(bar.getByTestId('note-counts')).not.toContainText('words');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pinned-metadata.png` });
    expect(errors).toEqual([]);
  });
});

async function openQuantaNote(page: Page, title: string): Promise<void> {
  await tree(page, 'Quanta').getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}
test.describe('in Quanta, with a folder and two notes', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Substation'],
      notes: [{ title: 'Alpha' }, { title: 'Beta' }],
    },
  });

  // Ryan’s feedback of 6 Nov 2026 (Personal), item 3.
  test('Token Count in the Metadata tab, and pinned under the title and in the status bar', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await openQuantaNote(page, 'Alpha');
    await page.getByTestId('note-body').locator('.ProseMirror').click();
    // Two tokens in GPT-4o's encoding.
    await page.keyboard.type('hello world');
    if (!(await page.getByTestId('note-info').isVisible())) {
      await page.getByTestId('note-tab-info').click();
    }
    const details = page.getByTestId('note-details');
    await expect(details.locator('dt', { hasText: 'Token Count' })).toHaveCount(1);
    await expect(page.getByTestId('info-tokens')).toHaveText('2');
    // Not in the status bar until pinned there.
    await expect(page.getByTestId('note-counts')).not.toContainText('tokens');

    await page.goto('/settings/note');
    await page.getByTestId('metadata-title-tokens').check();
    await page.getByTestId('metadata-status-tokens').check();
    await expect.poll(() => storedSetting(page, 'metadata.underTitle')).toEqual(['tokens']);
    await expect
      .poll(() => storedSetting(page, 'metadata.statusBar'))
      .toEqual(['words', 'characters', 'reading', 'tokens']);
    await expect(page.getByTestId('metadata-status-tokens').locator('..')).toContainText(
      'Token Count',
    );

    await page.goto('/');
    await openQuantaNote(page, 'Alpha');
    await expect(page.getByTestId('pinned-metadata').locator('[data-field="tokens"]')).toHaveText(
      '2 tokens',
    );
    await expect(page.getByTestId('note-counts').locator('[data-field="tokens"]')).toHaveText(
      '2 tokens',
    );
    // It follows the text.
    await page.getByTestId('note-body').locator('.ProseMirror').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' and more words here');
    await expect(page.getByTestId('note-counts').locator('[data-field="tokens"]')).toHaveText(
      '6 tokens',
    );
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/token-count.png` });
    expect(errors).toEqual([]);
  });
});
