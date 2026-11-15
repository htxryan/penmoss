import { anotherMac, expect, type Locator, type Page, seeded, test } from './fixtures';
import { NEW_FOLDER } from './keys';
import { notebookAction, notebookMenuItem } from './notebook-actions';
import { carried, pushed } from './support/sync';
import { body, collectErrors, newNote, ULID } from './support/app';

// T7 on a git notebook (T59): nested folders, manual order (drag and Alt+↑/↓), per-folder sort
// modes, and a second Mac on the same remote that follows along once git carries each change
// (Sync Now on both sides, as the File menu has it, instead of waiting for the push delay and
// the minute's pull).

const treeOf = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });
const item = (page: Page, name: string) =>
  treeOf(page).getByRole('treeitem', { name, exact: true });

/** The tree's visible rows (folder names and note titles) carrying `tag`, in order. */
async function rows(page: Page, tag: string): Promise<string[]> {
  const labels = await treeOf(page)
    .getByRole('treeitem')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label') ?? ''));
  return labels.filter((label) => label.endsWith(tag)).map((label) => label.replace(` ${tag}`, ''));
}

async function newFolder(page: Page, name: string, via: 'button' | 'shortcut') {
  if (via === 'button') await (await notebookAction(page, 'New Folder')).click();
  else await page.keyboard.press(NEW_FOLDER);
  const input = page.getByRole('textbox', { name: 'New folder name' });
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
  const row = item(page, name);
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(row).toBeFocused();
  return row;
}

async function newNoteInSidebar(page: Page, title: string) {
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await expect(item(page, title)).toBeVisible();
}

/**
 * Brings both rows fully into the sidebar's view before a drag. `dragTo` presses on the
 * source, then scrolls the target into view; Chromium picks the dragged element by hit-testing
 * the press point once the drag starts, so a scroll in between drags whichever row has moved
 * under it (a long tree from earlier runs clipped the target). Both must be fully visible
 * together when the drag starts.
 */
type SortMode = 'manual' | 'alpha' | 'modified';
const SORT_NAMES: Record<SortMode, string> = {
  manual: 'Manual',
  alpha: 'A–Z',
  modified: 'Modified',
};

/**
 * The sort order's menu (T52), for the folder `label` names ("Sort Order for Work"): Sort Order…
 * in the notebook row's ⋯ (R2-21), shown on hover (T53 item 4).
 */
async function openSort(page: Page, label: string): Promise<Locator> {
  await (await notebookMenuItem(page, 'Sort Order…')).click();
  const menu = page.getByRole('menu', { name: label, exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

/** The sort order in use for the folder `label` names, as its menu checks it. */
async function sortIn(page: Page, label: string): Promise<SortMode | undefined> {
  const menu = await openSort(page, label);
  const checked = await menu.getByRole('menuitemradio', { checked: true }).textContent();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  return (Object.keys(SORT_NAMES) as SortMode[]).find((mode) => SORT_NAMES[mode] === checked);
}

/** Chooses `mode` for the folder `label` names. */
async function chooseSort(page: Page, label: string, mode: SortMode) {
  const menu = await openSort(page, label);
  await menu.getByRole('menuitemradio', { name: SORT_NAMES[mode], exact: true }).click();
  await expect.poll(() => sortIn(page, label)).toBe(mode);
}

async function inView(source: Locator, target: Locator) {
  // Each row is scrolled to right before its own check (scrolling to one can move the other
  // out of view); the target again last, then the source must still be on screen with it.
  // To the middle of the tree: `scrollIntoViewIfNeeded` leaves a row that is all but a fraction
  // of a pixel in view where it is, at the edge (seen with macOS's font metrics in CI).
  for (const row of [target, source, target]) {
    await row.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await expect(row).toBeInViewport({ ratio: 1 });
  }
  await expect(source).toBeInViewport({ ratio: 1 });
}

/** Drags `source` onto the top or bottom edge of `target` (a reorder, not a move into it). */
async function dragBeside(source: Locator, target: Locator, side: 'before' | 'after') {
  await inView(source, target);
  const box = await target.boundingBox();
  if (!box) throw new Error('Drop target is not visible');
  await source.dragTo(target, {
    targetPosition: { x: box.width / 2, y: side === 'before' ? 3 : box.height - 3 },
  });
}

test('nested folders: create, reorder, sort, refuse a loop, and sync to a second Mac', async ({
  page,
  browser,
  notebook,
}) => {
  // Each change crosses to the second Mac through the remote.
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  const tag = `t${Date.now().toString(36)}`;
  const name = (base: string) => `${base} ${tag}`;
  await page.goto('/');
  await expect(treeOf(page)).toBeVisible();

  // Nested folders: one from the button at the top level, one inside it from the shortcut.
  await page.getByTestId('tree-root-drop').click();
  const projects = await newFolder(page, name('Projects'), 'button');
  await expect(projects).toHaveAttribute('aria-level', '1');
  const work = await newFolder(page, name('Work'), 'shortcut');
  await expect(work).toHaveAttribute('aria-level', '2');
  await expect(projects).toHaveAttribute('aria-expanded', 'true');

  // New notes go into the chosen folder, at the end in manual order.
  for (const title of ['Alpha', 'Bravo', 'Charlie']) await newNoteInSidebar(page, name(title));
  await expect(item(page, name('Alpha'))).toHaveAttribute('aria-level', '3');
  await expect
    .poll(() => rows(page, tag))
    .toEqual(['Projects', 'Work', 'Alpha', 'Bravo', 'Charlie']);

  // Drag reorder: Charlie above Alpha.
  await dragBeside(item(page, name('Charlie')), item(page, name('Alpha')), 'before');
  await expect
    .poll(() => rows(page, tag))
    .toEqual(['Projects', 'Work', 'Charlie', 'Alpha', 'Bravo']);

  // Keyboard reorder: Alt+↓ moves the focused note down one place and keeps focus.
  const charlie = item(page, name('Charlie'));
  await charlie.focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect
    .poll(() => rows(page, tag))
    .toEqual(['Projects', 'Work', 'Alpha', 'Charlie', 'Bravo']);
  await expect(charlie).toBeFocused();

  // Arrow keys walk the tree; ← on a note goes to its folder, ← again closes it.
  await page.keyboard.press('ArrowUp');
  await expect(item(page, name('Alpha'))).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(work).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(work).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(work).toHaveAttribute('aria-expanded', 'true');

  // A folder cannot move into its own subfolder: refused with a message, nothing changes.
  await inView(projects, work);
  await projects.dragTo(work);
  await expect(page.getByTestId('tree-message')).toHaveText(
    'A folder cannot move into itself or one of its subfolders.',
  );
  await expect(page.getByTestId('tree-message')).toBeInViewport();
  // The whole notice shows, never squeezed by the tree's rows (B7).
  const squeezed = await page
    .getByTestId('tree-message')
    .evaluate((element) => element.scrollHeight > element.clientHeight + 1);
  expect(squeezed, 'the refusal is cut off').toBe(false);
  await expect(work).toHaveAttribute('aria-level', '2');
  // It stays 6 s over the sidebar's last rows, and never takes a pointer meant for them (A558).
  const message = await page.getByTestId('tree-message').boundingBox();
  if (!message) throw new Error('The refusal is not visible');
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="tree-message"]') !== null,
    { x: message.x + message.width / 2, y: message.y + message.height / 2 },
  );
  expect(hit, 'the refusal takes the pointer').toBe(false);

  const other = await anotherMac(browser, { remote: seeded(notebook).remote });
  try {
    const device = other.page;
    const otherErrors = collectErrors(device);
    await device.goto('/');
    await carried(page, device, async () => {
      await expect(item(device, name('Projects'))).toBeVisible({ timeout: 2_000 });
    });
    await item(device, name('Projects')).click();
    await item(device, name('Work')).click();
    await expect
      .poll(() => rows(device, tag), { timeout: 15_000 })
      .toEqual(['Projects', 'Work', 'Alpha', 'Charlie', 'Bravo']);

    // A drag on the first device shows up live on the second, through the loop refusal if it
    // is still over the last row (Bravo) on a slower runner (A558).
    await dragBeside(item(page, name('Alpha')), item(page, name('Bravo')), 'after');
    await expect
      .poll(() => rows(page, tag))
      .toEqual(['Projects', 'Work', 'Charlie', 'Bravo', 'Alpha']);
    await carried(page, device, () =>
      expect
        .poll(() => rows(device, tag))
        .toEqual(['Projects', 'Work', 'Charlie', 'Bravo', 'Alpha']),
    );

    // Sort modes are per folder and sync; the order follows.
    // Work is still the chosen folder (new notes went into it).
    await expect(work).toHaveAttribute('aria-selected', 'true');
    const sort = `Sort Order for ${name('Work')}`;
    await chooseSort(page, sort, 'alpha');
    await expect
      .poll(() => rows(page, tag))
      .toEqual(['Projects', 'Work', 'Alpha', 'Bravo', 'Charlie']);
    await carried(page, device, async () => {
      await expect
        .poll(() => rows(device, tag))
        .toEqual(['Projects', 'Work', 'Alpha', 'Bravo', 'Charlie']);
      await expect.poll(() => sortIn(device, sort)).toBe('alpha');
    });
    // In a sorted folder, Alt+↑/↓ explains instead of moving.
    await item(page, name('Charlie')).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByTestId('tree-message')).toContainText('Switch it to Manual to reorder');

    // Modified: the note edited last comes first.
    await chooseSort(page, sort, 'modified');
    await item(page, name('Bravo')).click();
    await expect(page.getByTestId('note-title')).toHaveValue(name('Bravo'));
    await page.getByTestId('note-body').locator('.ProseMirror').click();
    await page.keyboard.type('edited');
    await expect
      .poll(() => rows(page, tag))
      .toEqual(['Projects', 'Work', 'Bravo', 'Charlie', 'Alpha']);
    await carried(page, device, () => expect.poll(() => sortIn(device, sort)).toBe('modified'));

    // Back to Manual: the manual order was kept.
    await chooseSort(page, sort, 'manual');
    await carried(page, device, () =>
      expect
        .poll(() => rows(device, tag))
        .toEqual(['Projects', 'Work', 'Charlie', 'Bravo', 'Alpha']),
    );

    // The top level has its own sort mode, which syncs too.
    await page.getByTestId('tree-root-drop').click();
    const rootSort = 'Sort Order for the Top Level';
    const before = (await sortIn(page, rootSort))!;
    await device.getByTestId('tree-root-drop').click();
    await chooseSort(page, rootSort, 'alpha');
    await carried(page, device, () => expect.poll(() => sortIn(device, rootSort)).toBe('alpha'));
    await chooseSort(page, rootSort, before);
    await carried(page, device, () => expect.poll(() => sortIn(device, rootSort)).toBe(before));

    // Rename with F2, then delete: the notes move up into Projects, on both devices.
    await work.focus();
    await page.keyboard.press('F2');
    const rename = page.getByRole('textbox', { name: `Rename folder ${name('Work')}` });
    await rename.fill(name('Desk'));
    await rename.press('Enter');
    const desk = item(page, name('Desk'));
    await expect(desk).toBeFocused();
    await carried(page, device, () => expect(item(device, name('Desk'))).toBeVisible());
    await page.keyboard.press('Delete');
    const dialog = page.getByRole('dialog', { name: `Delete “${name('Desk')}”?` });
    await expect(dialog).toContainText('Its 3 notes move to');
    await dialog.getByRole('button', { name: 'Delete Folder' }).click();
    await expect(desk).toHaveCount(0);
    await expect.poll(() => rows(page, tag)).toEqual(['Projects', 'Charlie', 'Bravo', 'Alpha']);
    await expect(item(page, name('Alpha'))).toHaveAttribute('aria-level', '2');
    await carried(page, device, () =>
      expect.poll(() => rows(device, tag)).toEqual(['Projects', 'Charlie', 'Bravo', 'Alpha']),
    );
    expect(otherErrors).toEqual([]);
  } finally {
    await other.context.close();
  }
  expect(errors).toEqual([]);
});

test('the folder tree shows offline from the local copy', async ({ page, host }) => {
  const errors = collectErrors(page);
  const tag = `t${Date.now().toString(36)}`;
  await page.goto('/');
  await page.getByTestId('tree-root-drop').click();
  await newFolder(page, `Offline ${tag}`, 'button');
  await newNoteInSidebar(page, `Kept ${tag}`);
  await expect.poll(() => rows(page, tag)).toEqual(['Offline', 'Kept']);
  // "Synced" means the remote and this device's own copy both hold every change; then git's
  // network stops answering and the page reloads.
  await pushed(page);
  host.network = 'held';
  await page.reload();
  await expect.poll(() => rows(page, tag)).toEqual(['Offline', 'Kept']);
  await expect(item(page, `Kept ${tag}`)).toHaveAttribute('aria-level', '2');
  host.network = 'up';

  expect(errors).toEqual([]);
});

const RUN = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
// T42, item 1.
test('a context menu on notes, a selection and folders: Move, Trash with Undo, Rename', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  // A folder to move into, made from the tree.
  await page.getByTestId('tree-root-drop').click();
  await (await notebookAction(page, 'New Folder')).click();
  await page.getByRole('textbox', { name: 'New folder name' }).fill(`Shelf ${RUN}`);
  await page.keyboard.press('Enter');
  const tree = page.getByRole('tree', { name: 'Folders and notes' });
  // The notes start in a folder of their own: in the shared workspace, other runs' notes can sit
  // between new ones at the top level, and a Shift range would take them in.
  await page.getByTestId('tree-root-drop').click();
  await (await notebookAction(page, 'New Folder')).click();
  await page.getByRole('textbox', { name: 'New folder name' }).fill(`Desk ${RUN}`);
  await page.keyboard.press('Enter');
  await tree.getByRole('treeitem', { name: `Desk ${RUN}`, exact: true }).click();
  await newNote(page, `Ctx one ${RUN}`, 'First.');
  await newNote(page, `Ctx two ${RUN}`, 'Second.');
  await newNote(page, `Ctx three ${RUN}`, 'Third.');
  await expect(tree).toHaveAttribute('aria-multiselectable', 'true');
  const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });
  const one = row(`Ctx one ${RUN}`);
  const two = row(`Ctx two ${RUN}`);
  const three = row(`Ctx three ${RUN}`);

  // A plain click opens a note; Shift-click selects the notes between, opening nothing.
  await one.click();
  await expect(page).toHaveURL(ULID);
  const opened = page.url();
  await three.click({ modifiers: ['Shift'] });
  expect(page.url()).toBe(opened);
  for (const each of [one, two, three]) await expect(each).toHaveAttribute('aria-selected', 'true');
  // Toggling one out: Ctrl here (⌘ on a Mac, where Ctrl-click is a right-click).
  await two.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(two).toHaveAttribute('aria-selected', 'false');
  await two.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(two).toHaveAttribute('aria-selected', 'true');

  // Right-click a selected note: the in-app menu acts on all three, and names them, as some
  // may be scrolled out of sight (review S1).
  await three.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '3 notes' });
  await expect(menu).toBeVisible();
  for (const name of ['one', 'two', 'three']) {
    await expect(menu).toHaveAccessibleName(new RegExp(`“Ctx ${name} ${RUN}”`));
    await expect(page.getByTestId('context-menu-caption')).toContainText(`“Ctx ${name} ${RUN}”`);
  }
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await menu.getByRole('menuitem', { name: 'Move 3 notes…' }).click();
  const picker = page.getByRole('dialog', { name: 'Move 3 notes to a folder' });
  await expect(picker).toBeVisible();
  await page.keyboard.type(`Shelf ${RUN}`);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('move-status')).toHaveText(`Moved 3 notes to Shelf ${RUN}`);
  const shelf = tree.getByRole('treeitem', { name: `Shelf ${RUN}`, exact: true });
  await expect(shelf).toHaveAttribute('aria-expanded', 'true');
  for (const each of [one, two, three]) await expect(each).toHaveAttribute('aria-level', '2');

  // From the keyboard: Shift+F10 on a note, which acts on it alone once the selection is gone.
  await one.click();
  await one.focus();
  await page.keyboard.press('Shift+F10');
  const single = page.getByRole('menu', { name: `“Ctx one ${RUN}”` });
  await expect(single).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(single).toHaveCount(0);
  await expect(one).toBeFocused();

  // Two notes to Trash, then Undo brings both back.
  await two.click({ modifiers: ['Shift'] });
  await two.click({ button: 'right' });
  await page
    .getByRole('menu', { name: '2 notes' })
    .getByRole('menuitem', { name: 'Move 2 notes to Trash' })
    .click();
  await expect(page.getByTestId('trashed-toast')).toContainText('Moved 2 notes to Trash');
  await expect(one).toHaveCount(0);
  await expect(two).toHaveCount(0);
  await page.getByTestId('trashed-undo').click();
  await expect(one).toBeVisible();
  await expect(two).toBeVisible();

  // A selection never lingers once a note is opened another way (back, search, a link): the
  // next Move or Trash cannot reach notes chosen earlier (review S1).
  await one.click();
  await two.click({ modifiers: ['Shift'] });
  await expect(two).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(one).toHaveAttribute('aria-selected', 'false');
  await expect(two).toHaveAttribute('aria-selected', 'false');
  // ⌘ or Ctrl-click with nothing chosen opens a tab and picks nothing (A1570); Space then takes
  // only that note, not the open one unseen.
  await two.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(two).toHaveAttribute('aria-selected', 'false');
  await expect(one).toHaveAttribute('aria-selected', 'false');
  await two.focus();
  await page.keyboard.press('Space');
  await expect(two).toHaveAttribute('aria-selected', 'true');
  await expect(one).toHaveAttribute('aria-selected', 'false');
  await two.click({ button: 'right' });
  await expect(page.getByRole('menu', { name: `“Ctx two ${RUN}”` })).toBeVisible();
  await page.keyboard.press('Escape');

  // A folder's menu: Rename, from the context-menu key.
  await shelf.focus();
  await page.keyboard.press('ContextMenu');
  const folderMenu = page.getByRole('menu', { name: `Folder Shelf ${RUN}` });
  await expect(folderMenu.getByRole('menuitem', { name: 'Delete Folder…' })).toBeVisible();
  await folderMenu.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('textbox', { name: `Rename folder Shelf ${RUN}` });
  await rename.fill(`Shelf2 ${RUN}`);
  await rename.press('Enter');
  await expect(tree.getByRole('treeitem', { name: `Shelf2 ${RUN}`, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

const tree = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });

const row = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });
// T53, items 4, 5, 12.
test('New Note on a notebook and a folder; New Folder Here and New Note Here beside a note', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();

  // The notebook's actions are on its name's row, hidden until hovered; the dot stays last.
  const head = page.locator('#app-sidebar .sb-section-head:has(.tree-actions)').first();
  await page.mouse.move(900, 400);
  await expect(head.locator('.tree-actions')).toBeHidden();
  await head.hover();
  const actions = (await head.locator('.tree-actions').boundingBox())!;
  const dot = (await head.locator('.sync-dot').first().boundingBox())!;
  expect(dot.x).toBeGreaterThanOrEqual(actions.x + actions.width - 1);
  // Open or Close Notebooks is not in the top row: with git notebooks only there are no Penmoss
  // notebooks to open or close (A828).
  await expect(page.getByTestId('sidebar-shortcuts').getByTestId('open-notebooks')).toHaveCount(0);

  // New Folder from the notebook's row.
  const box = `Box ${RUN}`;
  await (await notebookAction(page, 'New Folder')).click();
  const input = page.getByRole('textbox', { name: 'New folder name' });
  await input.fill(box);
  await input.press('Enter');
  await expect(row(page, box)).toBeVisible();
  const boxLevel = Number(await row(page, box).getAttribute('aria-level'));

  // A folder's hover actions start with New Note: a note in it, opened.
  await row(page, box).hover();
  await row(page, box).getByTestId('folder-row-new-note').click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  const inside = `Inside ${RUN}`;
  await page.keyboard.type(inside);
  await expect(row(page, inside)).toHaveAttribute('aria-level', String(boxLevel + 1));

  // The folder's menu has New Folder Here after New Note Here.
  await row(page, box).click({ button: 'right' });
  const folderMenu = page.getByRole('menu');
  await expect(folderMenu.getByRole('menuitem').nth(0)).toHaveText(/New Note Here/);
  await expect(folderMenu.getByRole('menuitem').nth(1)).toHaveText(/New Folder Here/);
  await page.keyboard.press('Escape');

  // A note's menu starts with New Note Here and New Folder Here, beside it in its folder.
  await row(page, inside).click({ button: 'right' });
  await page.getByTestId('note-new-folder').click();
  const sibling = `Sibling ${RUN}`;
  await page.getByRole('textbox', { name: 'New folder name' }).fill(sibling);
  await page.getByRole('textbox', { name: 'New folder name' }).press('Enter');
  await expect(row(page, sibling)).toHaveAttribute('aria-level', String(boxLevel + 1));
  await row(page, inside).click({ button: 'right' });
  await page.getByTestId('note-new-note').click();
  await expect(page.getByTestId('note-title')).toBeFocused();
  const next = `Next to it ${RUN}`;
  await page.keyboard.type(next);
  await expect(row(page, next)).toHaveAttribute('aria-level', String(boxLevel + 1));

  // The notebook's New Note: a note at its top level.
  await (await notebookAction(page, 'New Note in This Notebook')).click();
  await expect(page.getByTestId('note-title')).toBeFocused();
  const top = `Top ${RUN}`;
  await page.keyboard.type(top);
  await expect(row(page, top)).toHaveAttribute('aria-level', String(boxLevel));
  expect(errors).toEqual([]);
});

// T53.
test("4–5, follow-up (A990): a folder's hover actions lie over its row, so hovering moves nothing", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const name = `Hover Folder ${RUN}`;
  await expect(tree(page)).toBeVisible();
  await page.keyboard.press(NEW_FOLDER);
  await page.getByRole('textbox', { name: 'New folder name' }).fill(name);
  await page.keyboard.press('Enter');
  const folder = row(page, name);
  await expect(folder).toBeVisible();
  const actions = folder.locator('.row-actions');
  // Made from the keyboard, the folder has focus, which shows its actions too.
  await folder.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(900, 450);
  await expect(actions).toBeHidden();
  const label = folder.locator('.tree-label');
  await folder.scrollIntoViewIfNeeded();
  const before = await label.boundingBox();

  await folder.hover();
  await expect(actions).toBeVisible();
  // The name keeps its box: the actions take no room in the row's flow.
  expect(await label.boundingBox()).toEqual(before);
  const box = (await actions.boundingBox())!;
  const rowBox = (await folder.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(rowBox.y);
  expect(box.y + box.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
  expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  // On the row's own colour, opaque, so the name never shows through.
  const colour = await actions.evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(colour).not.toBe('none');

  // Still a working control: New Note (its only button since A1120) makes a note in the folder.
  await expect(actions.getByRole('button')).toHaveCount(1);
  await folder.getByRole('button', { name: `New Note in ${name}` }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9A-HJKMNP-TV-Z]{26}$/);
  await expect(page.getByTestId('note-title')).toBeFocused();
  expect(errors).toEqual([]);
});

const SHOTS = process.env['PENMOSS_EVIDENCE'];

const sidebar = (page: Page) => page.locator('#app-sidebar');

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

const notebookTree = (page: Page, name: string) =>
  section(page, name).getByRole('tree', { name: 'Folders and notes' });
test.describe('in Quanta, with two folders and two notes', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Substation', 'Geotech'],
      notes: [{ title: 'Alpha' }, { title: 'Penmoss Feedback' }],
    },
  });

  // Ryan’s feedback of 5 Nov 2026 (Personal), item 6.
  test('in Manual order a note goes above or between folders, and stays there', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const quanta = notebookTree(page, 'Quanta');
    const names = () =>
      quanta.getByRole('treeitem').evaluateAll((rows) => rows.map((row) => row.ariaLabel));
    await expect.poll(names).toEqual(['Substation', 'Geotech', 'Alpha', 'Penmoss Feedback']);
    // Alt+↑ on the first note steps it past the last folder, then past the first.
    await quanta.getByRole('treeitem', { name: 'Alpha', exact: true }).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(names).toEqual(['Substation', 'Alpha', 'Geotech', 'Penmoss Feedback']);
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(names).toEqual(['Alpha', 'Substation', 'Geotech', 'Penmoss Feedback']);
    // A note dropped on a folder's lower edge goes below it.
    const feedback = quanta.getByRole('treeitem', { name: 'Penmoss Feedback', exact: true });
    const substation = quanta.getByRole('treeitem', { name: 'Substation', exact: true });
    const box = (await substation.boundingBox())!;
    await feedback.dragTo(substation, {
      targetPosition: { x: box.width / 2, y: box.height - 2 },
    });
    await expect.poll(names).toEqual(['Alpha', 'Substation', 'Penmoss Feedback', 'Geotech']);
    // Kept after a reload.
    await page.reload();
    await expect.poll(names).toEqual(['Alpha', 'Substation', 'Penmoss Feedback', 'Geotech']);
    if (SHOTS) await sidebar(page).screenshot({ path: `${SHOTS}/manual-order.png` });
    expect(errors).toEqual([]);
  });
});

test.describe('in Personal, with nested folders', () => {
  test.use({
    seed: {
      name: 'Personal',
      folders: ['Penmoss', 'Penmoss/Feedback Archive', 'Penmoss/Work/Deep'],
      notes: [
        { title: 'Links', markdown: 'See the docs here.\n' },
        { title: 'Penmoss Feedback', markdown: 'Feedback.\n', folder: 'Penmoss' },
        { title: 'In Deep', markdown: 'Deep down.\n', folder: 'Penmoss/Work/Deep' },
      ],
    },
  });

  // T67, item #231.
  test('every folder opens and closes, an empty one too; each level is indented', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await expect(tree(page)).toBeVisible();
    const penmoss = row(page, 'Penmoss');
    await penmoss.locator('.twisty').click();
    await expect(penmoss).toHaveAttribute('aria-expanded', 'true');

    // The empty subfolder has a chevron, opens to say it is empty, and closes again.
    const archive = row(page, 'Feedback Archive');
    await expect(archive).toHaveAttribute('aria-expanded', 'false');
    await expect(archive.locator('.twisty')).toBeVisible();
    await archive.locator('.twisty').click();
    await expect(archive).toHaveAttribute('aria-expanded', 'true');
    await expect(tree(page).getByTestId('tree-empty-folder')).toHaveText('Empty');
    await archive.locator('.twisty').click();
    await expect(archive).toHaveAttribute('aria-expanded', 'false');
    await expect(tree(page).getByTestId('tree-empty-folder')).toHaveCount(0);
    // From the keyboard too: → opens it, ← closes it.
    await archive.focus();
    await page.keyboard.press('ArrowRight');
    await expect(archive).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(archive).toHaveAttribute('aria-expanded', 'false');

    // Two levels down, a subfolder opens and closes like a top-level one.
    const work = row(page, 'Work');
    await work.locator('.twisty').click();
    const deep = row(page, 'Deep');
    await deep.locator('.twisty').click();
    await expect(row(page, 'In Deep')).toBeVisible();
    await deep.locator('.twisty').click();
    await expect(row(page, 'In Deep')).toBeHidden();
    await deep.locator('.twisty').click();

    // Each level is indented: a row's chevron sits under its parent's icon, and a note's icon
    // one step in from its folder's.
    const centre = async (locator: ReturnType<typeof row>, part: string) => {
      const found = (await locator.locator(part).first().boundingBox())!;
      return found.x + found.width / 2;
    };
    expect(await centre(work, '.twisty')).toBeCloseTo(await centre(penmoss, '.tree-icon'), 0);
    expect(await centre(deep, '.twisty')).toBeCloseTo(await centre(work, '.tree-icon'), 0);
    const step =
      (await centre(row(page, 'In Deep'), '.tree-icon')) - (await centre(deep, '.tree-icon'));
    expect(step).toBeGreaterThan(20);
    expect(await centre(row(page, 'Penmoss Feedback'), '.tree-icon')).toBeCloseTo(
      (await centre(penmoss, '.tree-icon')) + step,
      0,
    );
    if (SHOTS) await page.locator('.sidebar').screenshot({ path: `${SHOTS}/nested-folders.png` });
    expect(errors).toEqual([]);
  });
});

const PALETTE = 'ControlOrMeta+KeyK';

const treeRow = (page: Page, name: string) =>
  treeOf(page).getByRole('treeitem', { name, exact: true });

async function newNoteFromButton(page: Page, title: string, text = ''): Promise<string> {
  await page
    .getByRole('button', { name: /^New Note/ })
    .first()
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  if (text) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(text);
  }
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

async function newFolderFromKeys(page: Page, name: string) {
  await page.keyboard.press(NEW_FOLDER);
  const input = page.getByRole('textbox', { name: 'New folder name' });
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
  await expect(treeRow(page, name)).toBeVisible();
}

async function runFromPalette(page: Page, title: string) {
  await page.keyboard.press(PALETTE);
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type(title);
  await palette
    .getByRole('option', { name: new RegExp(title.replace('…', '')) })
    .first()
    .click();
}

// T39 pass 1.
test('Move to folder… files the open note from the keyboard', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(treeOf(page)).toBeVisible();
  await page.getByTestId('tree-root-drop').click();
  const folder = `Filing ${RUN}`;
  await newFolderFromKeys(page, folder);
  await page.getByTestId('tree-root-drop').click();
  const title = `Loose note ${RUN}`;
  await newNoteFromButton(page, title, 'To be filed.');
  await expect(treeRow(page, title)).toHaveAttribute('aria-level', '1');

  await runFromPalette(page, 'Move to Folder…');
  const picker = page.getByRole('dialog', { name: `Move “${title}” to a folder` });
  await expect(picker).toBeVisible();
  // Where the note is now is marked, and typing finds a folder by its path.
  await expect(picker.getByRole('option', { name: /Top level/ })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await page.keyboard.type(`filing ${RUN}`);
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(page.getByTestId('move-status')).toHaveText(`Moved to ${folder}`);
  // Focus goes back to the note, where it was before the palette (T39 review).
  await expect(body(page)).toBeFocused();
  await expect(treeRow(page, title)).toHaveAttribute('aria-level', '2');
  await expect(treeRow(page, folder)).toHaveAttribute('aria-expanded', 'true');

  // Choosing where it already is changes nothing, and says so.
  await runFromPalette(page, 'Move to Folder…');
  await page.keyboard.type(`filing ${RUN}`);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('move-status')).toHaveText(`Already in ${folder}`);
  expect(errors).toEqual([]);
});

// T39 pass 1.
test('a note opened by its address shows in the tree, its folders open', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(treeOf(page)).toBeVisible();
  await page.getByTestId('tree-root-drop').click();
  const outer = `Outer ${RUN}`;
  const inner = `Inner ${RUN}`;
  await newFolderFromKeys(page, outer);
  await newFolderFromKeys(page, inner);
  const title = `Nested note ${RUN}`;
  const id = await newNoteFromButton(page, title, 'Deep down.');
  await expect(treeRow(page, title)).toHaveAttribute('aria-level', '3');
  // Close the folders, then open the note by its address (a reload, a link, the Mac app).
  await treeRow(page, outer).click();
  await page.keyboard.press('ArrowLeft');
  await expect(treeRow(page, outer)).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(500); // The expanded state is stored on this device.
  await page.goto(`/notes/${id}`);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
  await expect(treeRow(page, title)).toBeVisible();
  await expect(treeRow(page, title)).toBeInViewport();
  await expect(treeRow(page, outer)).toHaveAttribute('aria-expanded', 'true');
  await expect(treeRow(page, inner)).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
});
