import { anotherMac, expect, seeded, test, type Locator, type Page } from './fixtures';
import { NEW_FOLDER } from './keys';
import { notebookAction } from './notebook-actions';
import { carried } from './support/sync';

// T7 on a git notebook (T59): nested folders, manual order (drag and Alt+↑/↓), per-folder sort
// modes, and a second Mac on the same remote that follows along once git carries each change
// (Sync Now on both sides, as the File menu has it, instead of waiting for the push delay and
// the minute's pull).

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

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

async function newNote(page: Page, title: string) {
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

/** The sort order is a menu on the notebook's bar (T52): open it, choose `mode`. */
/** The sort order's button, shown or not (it is on the notebook's row, on hover: T53). */
const sortOrder = (page: Page, label: string) =>
  page.locator(`[data-testid="sort-order"][aria-label="${label}"]`);

async function chooseSort(button: Locator, mode: SortMode) {
  // On the notebook's row, shown on hover (T53 item 4).
  await button.page().locator('.sb-section-head:has(.tree-actions)').first().hover();
  await button.click();
  const item = button.page().getByRole('menuitemradio', { name: SORT_NAMES[mode], exact: true });
  await item.click();
  await expect(button).toHaveAttribute('data-sort', mode);
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
  for (const title of ['Alpha', 'Bravo', 'Charlie']) await newNote(page, name(title));
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
    const sort = sortOrder(page, `Sort Order for ${name('Work')}`);
    await chooseSort(sort, 'alpha');
    await expect
      .poll(() => rows(page, tag))
      .toEqual(['Projects', 'Work', 'Alpha', 'Bravo', 'Charlie']);
    await carried(page, device, async () => {
      await expect
        .poll(() => rows(device, tag))
        .toEqual(['Projects', 'Work', 'Alpha', 'Bravo', 'Charlie']);
      await expect(sortOrder(device, `Sort Order for ${name('Work')}`)).toHaveAttribute(
        'data-sort',
        'alpha',
      );
    });
    // In a sorted folder, Alt+↑/↓ explains instead of moving.
    await item(page, name('Charlie')).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByTestId('tree-message')).toContainText('Switch it to Manual to reorder');

    // Modified: the note edited last comes first.
    await chooseSort(sort, 'modified');
    await item(page, name('Bravo')).click();
    await expect(page.getByTestId('note-title')).toHaveValue(name('Bravo'));
    await page.getByTestId('note-body').locator('.ProseMirror').click();
    await page.keyboard.type('edited');
    await expect
      .poll(() => rows(page, tag))
      .toEqual(['Projects', 'Work', 'Bravo', 'Charlie', 'Alpha']);
    await carried(page, device, () =>
      expect(sortOrder(device, `Sort Order for ${name('Work')}`)).toHaveAttribute(
        'data-sort',
        'modified',
      ),
    );

    // Back to Manual: the manual order was kept.
    await chooseSort(sort, 'manual');
    await carried(page, device, () =>
      expect
        .poll(() => rows(device, tag))
        .toEqual(['Projects', 'Work', 'Charlie', 'Bravo', 'Alpha']),
    );

    // The top level has its own sort mode, which syncs too.
    await page.getByTestId('tree-root-drop').click();
    const rootSort = sortOrder(page, 'Sort Order for the Top Level');
    const before = (await rootSort.getAttribute('data-sort')) as SortMode;
    await device.getByTestId('tree-root-drop').click();
    const otherRootSort = sortOrder(device, 'Sort Order for the Top Level');
    await chooseSort(rootSort, 'alpha');
    await carried(page, device, () => expect(otherRootSort).toHaveAttribute('data-sort', 'alpha'));
    await chooseSort(rootSort, before);
    await carried(page, device, () => expect(otherRootSort).toHaveAttribute('data-sort', before));

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
  await newNote(page, `Kept ${tag}`);
  await expect.poll(() => rows(page, tag)).toEqual(['Offline', 'Kept']);
  // "Synced" means the remote and this device's own copy both hold every change; then git's
  // network stops answering and the page reloads.
  await expect(page.getByTestId('section-sync')).toHaveAttribute('data-state', 'synced', {
    timeout: 40_000,
  });
  await expect(page.getByTestId('section-sync')).toHaveAttribute('data-pending', '0', {
    timeout: 40_000,
  });
  host.network = 'held';
  await page.reload();
  await expect.poll(() => rows(page, tag)).toEqual(['Offline', 'Kept']);
  await expect(item(page, `Kept ${tag}`)).toHaveAttribute('aria-level', '2');
  host.network = 'up';

  expect(errors).toEqual([]);
});
