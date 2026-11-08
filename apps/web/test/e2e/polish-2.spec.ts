import { expect, test, type Page } from './fixtures';
import { noteAction } from './note-menu';
import { notebookAction } from './notebook-actions';
import { storedRecord } from './stored';

// T39 pass 2 (web): what a fresh look after pass 1 turned up. Undo and Redo in a new note,
// the sidebar list's room, the calendar as one Tab stop, Undo after Move to Trash, focus
// after Escape in the tag field, search's empty state, and a sync pill that is read out only
// when it needs attention. On a git notebook (T59): search is this device's, and the notebook's
// sync dot is the one read out.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const UNDO = 'ControlOrMeta+KeyZ';
const REDO = 'ControlOrMeta+Shift+KeyZ';
const SEARCH = 'ControlOrMeta+Shift+KeyF';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const tree = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });

async function newNote(page: Page, title: string, text = ''): Promise<string> {
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

test('Undo and Redo in a new note: one Redo brings the words back, with no stray line', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Undo ${RUN}`, 'First words');
  // A pause in typing ends an undo step.
  await page.waitForTimeout(800);
  await page.keyboard.type(' and more');
  await expect(body(page)).toHaveText('First words and more');

  await page.keyboard.press(UNDO);
  await expect(body(page)).toHaveText('First words');
  await page.keyboard.press(UNDO);
  await expect(body(page)).toHaveText('');
  await page.keyboard.press(REDO);
  await expect(body(page)).toHaveText('First words');
  await page.keyboard.press(REDO);
  await expect(body(page)).toHaveText('First words and more');
  // One paragraph, as typed: nothing was added around the steps.
  await expect(body(page).locator(':scope > *')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('the sidebar list keeps room for its rows in a 900 px window', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(tree(page)).toBeVisible();
  // The Notebooks section of the sidebar (T53 item 8, A983). A git notebook's tree sits in its
  // own section under its name's row (T50), so the room is the section body's, the notebook's
  // tree in it.
  const listHeight = () =>
    page
      .locator('.sb-notebooks-body')
      .evaluate((element) => Math.round(element.getBoundingClientRect().height));
  await expect(page.locator('.sb-notebooks-body .sb-section-body > .folders')).toBeVisible();
  // 12rem: about six rows (it was 7.5rem, three rows, beside the calendar and the tags).
  expect(await listHeight()).toBeGreaterThanOrEqual(12 * 16);
  // A shorter window scrolls the sidebar as one, the list showing every row it has.
  await page.setViewportSize({ width: 1440, height: 820 });
  for (const selector of ['.sb-notebooks-body', '.sb-notebooks-body .sb-section-body > .folders']) {
    await expect
      .poll(() => page.locator(selector).evaluate((element) => getComputedStyle(element).overflowY))
      .toBe('visible');
  }
  expect(errors).toEqual([]);
});

test('the calendar is one Tab stop, moved around with the arrow keys', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const calendar = page.getByTestId('calendar');
  await expect(calendar).toBeVisible();
  // Announced as a grid, whose keys move within it.
  await expect(calendar.getByRole('grid')).toBeVisible();
  await expect(calendar.getByRole('gridcell').first()).toBeVisible();
  const today = calendar.locator('[aria-current="date"]');
  const todayDate = (await today.getAttribute('data-date'))!;
  // The section's Move and Hide follow its title (T53 item 8, A988), before the month buttons;
  // from the last of those, Next Month, Tab reaches today's cell, and the next Tab leaves.
  await calendar.locator('.sb-section-toggle').focus();
  await page.keyboard.press('Tab');
  await expect(calendar.getByTestId('section-move')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(calendar.getByTestId('section-hide')).toBeFocused();
  await calendar.getByRole('button', { name: 'Next Month' }).focus();
  await page.keyboard.press('Tab');
  await expect(today).toBeFocused();
  expect(await calendar.locator('table [tabindex="0"]').count()).toBe(1);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('.calendar-grid'))).toBeNull();

  // The arrows move by a day; Home goes to Monday, and Left from Monday to its week.
  await page.keyboard.press('Shift+Tab');
  await expect(today).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const next = new Date(`${todayDate}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  await expect(calendar.locator(`[data-date="${next.toISOString().slice(0, 10)}"]`)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.locator(':focus')).toHaveAttribute('data-cell', /^d:/);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator(':focus')).toHaveClass(/calendar-week/);
  // Page Down shows the next month, focus on the same week.
  const heading = calendar.locator('#calendar-heading');
  const month = await heading.innerText();
  await page.keyboard.press('PageDown');
  await expect(heading).not.toHaveText(month);
  await expect(page.locator(':focus')).toHaveClass(/calendar-week/);
  expect(errors).toEqual([]);
});

test('Move to Trash offers Undo, which brings the note back where it was', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const title = `Trashed ${RUN}`;
  const id = await newNote(page, title, 'Not for the bin.');
  await expect(tree(page).getByRole('treeitem', { name: title, exact: true })).toBeVisible();

  await noteAction(page, 'delete-note');
  await expect(page).toHaveURL(/\/$/);
  const toast = page.getByTestId('trashed-toast');
  await expect(toast).toContainText(`Moved “${title}” to Trash`);
  // The note it was in has gone: focus is on Undo, not lost to the page.
  const undo = toast.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/notes/${id}$`));
  await expect(body(page)).toHaveText('Not for the bin.');
  // The toast held focus and has gone: the restored note's body has it.
  await expect(body(page)).toBeFocused();
  await expect(tree(page).getByRole('treeitem', { name: title, exact: true })).toBeVisible();
  await expect(toast).toBeHidden();

  // Escape dismisses it; focus goes to the main column.
  await noteAction(page, 'delete-note');
  await expect(undo).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toast).toBeHidden();
  await expect(page.locator('.note-main')).toBeFocused();
  await expect(tree(page).getByRole('treeitem', { name: title, exact: true })).toHaveCount(0);

  // The close button too, reached from Undo with Tab.
  await newNote(page, `Trashed too ${RUN}`, 'Also going.');
  await noteAction(page, 'delete-note');
  await expect(undo).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(toast.getByRole('button', { name: 'Dismiss' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toast).toBeHidden();
  await expect(page.locator('.note-main')).toBeFocused();
  expect(errors).toEqual([]);
});

test('Escape in the tag field gives focus back to Add a tag', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Tags ${RUN}`, 'Text.');
  const info = page.getByRole('complementary', { name: 'Metadata' });
  if (!(await info.isVisible())) {
    // Metadata's tab icon down the note's edge opens it (T53 item 9).
    await page.getByTestId('note-tab-info').click();
  }
  await info.getByRole('button', { name: 'Add a Tag' }).click();
  const field = info.getByRole('combobox', { name: 'Add a tag' });
  await expect(field).toBeFocused();
  // Matches no tag, so no suggestions are open for Escape to close first (A577).
  await page.keyboard.type(`half${RUN}`);
  await page.keyboard.press('Escape');
  await expect(field).toBeHidden();
  await expect(info.getByRole('button', { name: 'Add a Tag' })).toBeFocused();
  expect(errors).toEqual([]);
});

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
  const quiet = await newNote(page, 'Quiet shelf', 'Plain words only.');
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

test('the sync pill is read out only when it needs attention', async ({ page, context, host }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await newNote(page, `Pill ${RUN}`, 'Text.');
  // The notebook's dot (A933), and the sidebar's live region.
  const pill = page.getByTestId('section-sync');
  const alert = page.getByTestId('sync-alert');
  await expect(pill).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });
  // Not a live region itself: Syncing and Synced on every edit are not announced.
  expect(await pill.getAttribute('role')).toBeNull();
  await expect(alert).toHaveText('');
  // The Mac loses its network: a remote on this Mac needs none (#174 review), so git's is taken
  // down too, and the next push fails as it would.
  await context.setOffline(true);
  host.network = 'down';
  await body(page).click();
  await page.keyboard.type(' More.');
  await expect(pill).toHaveAttribute('data-state', 'offline', { timeout: 40_000 });
  await expect(alert).toContainText('Offline');
  host.network = 'up';
  await context.setOffline(false);
  await expect(pill).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });
  await expect(alert).toHaveText('');
  expect(errors).toEqual([]);
});
