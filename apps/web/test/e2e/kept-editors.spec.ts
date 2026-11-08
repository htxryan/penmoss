import { anotherMac, expect, seeded, test, type Page } from './fixtures';
import { NEW_NOTE, DOC_END, LINE_START } from './keys';
import { noteAction } from './note-menu';
import { notebookAction } from './notebook-actions';
import { asAgent, carried, syncNow } from './support/sync';

// T31: the editors of the notes shown last are kept (apps/web/src/notes/kept-editors.ts), so
// switching back to one shows it at once. A kept editor must stay what a freshly opened one
// would show: current with every change made meanwhile (on a git notebook, T59: another Mac's
// and an agent's, once git carries them), with its own undo history, and never kept for a note
// that left the list or fell out of the two kept. (The server's restore of a note from its R2
// copy under a new epoch went with the server.) Each editor element gets a mark in the page:
// the mark coming back means the kept editor was shown again, no mark means the note was
// opened afresh.

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
const tree = (page: Page) => page.getByTestId('note-list');

async function synced(page: Page) {
  const dot = page.getByTestId('section-sync');
  await expect(dot).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });
  await expect(dot).toHaveAttribute('data-pending', '0', { timeout: 40_000 });
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

/** Switches to a note from the sidebar and waits until it shows. */
async function show(page: Page, title: string) {
  await tree(page).getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('note-title')).toHaveValue(title);
  await expect(page.locator('.note-editor')).toHaveCount(1);
}

/** Marks the shown editor element; `markOf` reads the mark back after switching. */
function mark(page: Page, value: string) {
  return page.locator('.note-editor').evaluate((element, v) => {
    (element as HTMLElement).dataset['kept'] = v;
  }, value);
}

function markOf(page: Page) {
  return page.locator('.note-editor').getAttribute('data-kept');
}

test('a kept note shows changes made while it was hidden, and keeps its own undo', async ({
  page,
  browser,
  host,
  notebook,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  await page.goto('/');
  const a = `Kept current ${RUN}`;
  const b = `Kept other ${RUN}`;
  const idA = await newNote(page, a, 'Alpha line');
  await newNote(page, b, 'Beta line');
  await syncNow(page);
  await synced(page);
  await show(page, a);
  await mark(page, 'a');
  await show(page, b);

  // While A is hidden: another Mac types in it, and an agent on its own clone appends to it.
  const other = await anotherMac(browser, { remote });
  try {
    const device = other.page;
    await device.goto(`/notes/${idA}`);
    const deviceBody = device.getByTestId('note-body').locator('.ProseMirror');
    await expect(deviceBody).toContainText('Alpha line', { timeout: 40_000 });
    await deviceBody.click();
    await device.keyboard.press(DOC_END);
    await device.keyboard.type(' and from elsewhere');
    await syncNow(device);
    await synced(device);
  } finally {
    await other.context.close();
  }
  await asAgent(host, remote, `Kept agent ${RUN}`, (local) => {
    local.edit(idA, { op: 'append', markdown: `Agent line ${RUN}` }, null);
  });
  // This Mac pulls both while B is shown.
  await syncNow(page);

  // Back to A: the kept editor, with both changes.
  await show(page, a);
  expect(await markOf(page)).toBe('a');
  await expect(body(page)).toContainText('Alpha line and from elsewhere');
  await expect(body(page)).toContainText(`Agent line ${RUN}`);

  // Undo stays per note: typing in A, then in B, then undo in A undoes only A's typing.
  await body(page).click();
  await page.keyboard.press(DOC_END);
  await page.keyboard.type(' typed in A');
  await expect(body(page)).toContainText('typed in A');
  await show(page, b);
  await body(page).click();
  await page.keyboard.press(DOC_END);
  await page.keyboard.type(' typed in B');
  await show(page, a);
  expect(await markOf(page)).toBe('a');
  await body(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(body(page)).not.toContainText('typed in A');
  // The other device's and the agent's changes are not this editor's to undo.
  await expect(body(page)).toContainText('Alpha line and from elsewhere');
  await expect(body(page)).toContainText(`Agent line ${RUN}`);
  await show(page, b);
  await expect(body(page)).toContainText('Beta line typed in B');
  await synced(page);
  expect(errors).toEqual([]);
});

test('a kept note keeps its caret, and focus moves as when it opened afresh', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const a = `Kept caret ${RUN}`;
  const b = `Kept caret other ${RUN}`;
  await newNote(page, a, 'one two three');
  await newNote(page, b, 'Beta');
  await show(page, a);
  await mark(page, 'a');
  // The caret after "one".
  await body(page).getByText('one two three').click();
  await page.keyboard.press(LINE_START);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');

  await show(page, b);
  // The hidden editor holds no focus.
  expect(await page.evaluate(() => document.activeElement?.closest('.ProseMirror') !== null)).toBe(
    false,
  );
  await show(page, a);
  expect(await markOf(page)).toBe('a');
  // As for a note opened afresh, showing it leaves focus where the click put it.
  await expect(body(page)).not.toBeFocused();
  // Focused again, the editor goes on where its caret was.
  await body(page).focus();
  await page.keyboard.type('X');
  await expect(body(page)).toHaveText('oneX two three');
  // Enter in the title still moves to the start of the body.
  await page.getByTestId('note-title').click();
  await page.keyboard.press('Enter');
  await expect(body(page)).toBeFocused();
  await page.keyboard.type('Y');
  await expect(body(page)).toHaveText('YoneX two three');
  // A click into a kept editor puts the caret where it clicks, not where it was.
  await show(page, b);
  await show(page, a);
  expect(await markOf(page)).toBe('a');
  // (The middle of the line is past its end: the caret goes to the end.)
  await body(page).getByText('YoneX two three').click();
  await page.keyboard.type('Z');
  await expect(body(page)).toHaveText('YoneX two threeZ');
  await synced(page);
  expect(errors).toEqual([]);
});

test('at most two notes are kept, and none for a note gone from the list', async ({
  page,
  browser,
  notebook,
}) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await page.goto('/');
  const titles = [1, 2, 3, 4].map((n) => `Kept bound ${n} ${RUN}`);
  const ids: string[] = [];
  for (const title of titles) ids.push(await newNote(page, title, `Text of ${title}`));
  await synced(page);
  const [a, b, c, d] = titles as [string, string, string, string];

  // Two kept: after A, B, C and D, A is no longer kept, C is.
  await show(page, a);
  await mark(page, 'a');
  for (const title of [b, c]) {
    await show(page, title);
    await mark(page, title);
  }
  await show(page, d);
  await show(page, c);
  expect(await markOf(page)).toBe(c);
  await show(page, a);
  expect(await markOf(page)).toBeNull();
  await mark(page, 'a again');

  // Moved to Trash on another Mac while kept here: gone from the list and not kept, so
  // after a restore from Trash it opens afresh.
  await mark(page, 'a before trash');
  await show(page, b);
  await syncNow(page);
  const other = await anotherMac(browser, { remote: seeded(notebook).remote });
  try {
    const device = other.page;
    await device.goto(`/notes/${ids[0]}`);
    // A Mac without the note clones it first.
    await expect(device.getByTestId('note-title')).toHaveValue(a, { timeout: 40_000 });
    await expect(device.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
    await noteAction(device, 'delete-note');
    // Closed here once the deletion arrives, so the list drops it as for any closed note.
    await carried(device, page, () =>
      expect(tree(page).getByRole('link', { name: a, exact: true })).toHaveCount(0),
    );
    // The notebook's Trash, on its name's row (T53 item 4).
    await (await notebookAction(device, 'Trash', { role: 'link' })).click();
    const entry = device.getByTestId('trash').locator(`[data-note-id="${ids[0]}"]`);
    await entry.getByRole('button', { name: `Restore ${a}` }).click();
    await expect(device).toHaveURL(new RegExp(`/notes/${ids[0]}$`));
    // Back in the list once git carries the restore.
    await carried(device, page, () =>
      expect(tree(page).getByRole('link', { name: a, exact: true })).toHaveCount(1),
    );
  } finally {
    await other.context.close();
  }
  await show(page, a);
  expect(await markOf(page)).toBeNull();
  expect(errors).toEqual([]);
});
