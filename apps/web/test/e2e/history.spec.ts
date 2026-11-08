import { anotherMac, expect, seeded, test, type GitHost, type Page } from './fixtures';
import { NEW_FOLDER, NEW_NOTE, VERSION_HISTORY, LINE_END } from './keys';
import { noteAction } from './note-menu';
import { notebookAction } from './notebook-actions';
import { asAgent, syncNow } from './support/sync';
import { readRemote, remoteFiles, remoteMarkdown } from './support/remote';

// T21 on a git notebook (T59, A858): version history (each sync is a commit, attributed to its
// writer; a diff; restore as a new change that reaches another Mac), reverting an agent's
// commit, and Trash (restore into the folder it was deleted from, and delete for good after
// Touch ID). "Save a Version Now" is "Sync Now" here: a version is a commit.

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
const panel = (page: Page) => page.getByTestId('history-panel');
const tree = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });

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

/** Pushes, then waits until the remote's rendered markdown of the note holds `text`. */
async function pushed(page: Page, host: GitHost, remote: string, id: string, text: string) {
  await syncNow(page);
  await expect
    .poll(() => remoteMarkdown(host, remote, id) ?? '', { timeout: 40_000 })
    .toContain(text);
}

test('history shows attributed versions with a diff, and restores one as a new change', async ({
  page,
  browser,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  await page.goto('/');
  const id = await newNote(page, `Trip ${RUN}`, 'Book the night train');

  // On demand: Sync Now saves a version (a commit) of the note as it is.
  await page.keyboard.press(VERSION_HISTORY);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId('history-auto')).toContainText(
    'Each sync with git is a version',
  );
  await panel(page).getByRole('button', { name: 'Sync Now' }).click();
  await expect(panel(page).getByTestId('history-status')).toContainText('Saved a version');
  const first = panel(page).getByRole('list', { name: 'Versions' }).getByRole('button').first();
  await expect(first).toContainText('Penmoss for Mac');
  await expect(first).toContainText('Device');
  await expect.poll(() => remoteMarkdown(host, remote, id) ?? '').toContain('Book the night train');
  // The History tab of the note's side panel (T51, A936): the panel closes.
  await page.getByTestId('note-panel-close').click();
  await expect(panel(page)).toHaveCount(0);

  // Rewrite the note, and wait until it is stored and waits for its push.
  await body(page).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Fly instead');
  await expect(page.getByTestId('section-sync')).toHaveAttribute('data-pending', '1');

  // Not pushed yet, the change is not a version; the saved one's diff, then restore it.
  await page.getByTestId('note-tab-history').click();
  await expect(panel(page).getByRole('listitem').first()).toContainText(
    'Not saved as a version yet',
  );
  const saved = panel(page).getByRole('list', { name: 'Versions' }).getByRole('button').first();
  await saved.click();
  const diff = panel(page).getByTestId('history-diff');
  await expect(diff.locator('[data-op="add"]')).toContainText(['Book the night train']);
  await panel(page).getByRole('button', { name: 'Restore This Version' }).click();
  await expect(panel(page).getByTestId('history-status')).toContainText('as a new change');
  // The open editor gets the restore as an ordinary change.
  await expect(body(page)).toHaveText('Book the night train');
  await expect(
    panel(page).getByRole('button').filter({ hasText: 'Restore' }).first(),
  ).toBeVisible();

  // Another Mac sees it too.
  await pushed(page, host, remote, id, 'Book the night train');
  expect(remoteMarkdown(host, remote, id)).not.toContain('Fly instead');
  const other = await anotherMac(browser, { remote });
  try {
    const device = other.page;
    await device.goto(`/notes/${id}`);
    await expect(device.getByTestId('note-body').locator('.ProseMirror')).toHaveText(
      'Book the night train',
      { timeout: 40_000 },
    );
  } finally {
    await other.context.close();
  }
  expect(errors).toEqual([]);
});

test("reverts an agent's edit, keeping a later edit by the user", async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  await page.goto('/');
  const id = await newNote(page, `Agent ${RUN}`, 'Written by Ryan');
  await pushed(page, host, remote, id, 'Written by Ryan');

  // An agent on its own clone (the local MCP, A993) appends a paragraph and pushes it.
  await asAgent(host, remote, `Claude ${RUN}`, (local) => {
    local.edit(id, { op: 'append', markdown: 'Summary added by Claude' }, null);
  });
  await expect(async () => {
    await syncNow(page);
    await expect(body(page)).toContainText('Summary added by Claude', { timeout: 2_000 });
  }).toPass({ timeout: 40_000 });

  // The user keeps writing in the first paragraph.
  await body(page).getByText('Written by Ryan').click();
  await page.keyboard.press(LINE_END);
  await page.keyboard.type(', then edited');
  await pushed(page, host, remote, id, 'Written by Ryan, then edited');

  await page.getByTestId('note-tab-history').click();
  const agentVersion = panel(page)
    .getByRole('list', { name: 'Versions' })
    .getByRole('button', { name: new RegExp(`Claude ${RUN}`) });
  await expect(agentVersion).toBeVisible({ timeout: 15_000 });
  await agentVersion.click();
  await expect(panel(page).getByTestId('history-diff').locator('[data-op="add"]')).toContainText([
    'Summary added by Claude',
  ]);
  await panel(page).getByRole('button', { name: 'Revert This Edit' }).click();
  await expect(panel(page).getByTestId('history-status')).toContainText('later edits are kept');
  await expect(body(page)).not.toContainText('Summary added by Claude');
  await expect(body(page)).toContainText('Written by Ryan, then edited');
  expect(errors).toEqual([]);
});

test('Trash restores a note into its folder, and deletes it for good', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  await page.goto('/');
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  const folder = `Archive ${RUN}`;
  await page.keyboard.press(NEW_FOLDER);
  const name = page.getByRole('textbox', { name: 'New folder name' });
  await name.fill(folder);
  await name.press('Enter');
  await expect(tree(page).getByRole('treeitem', { name: folder, exact: true })).toBeFocused();
  const title = `Receipts ${RUN}`;
  const id = await newNote(page, title, 'Keep for taxes');
  const row = tree(page).getByRole('treeitem', { name: title, exact: true });
  await expect(row).toHaveAttribute('aria-level', '2');
  await pushed(page, host, remote, id, 'Keep for taxes');

  await noteAction(page, 'delete-note');
  await expect(row).toHaveCount(0);
  // The notebook's Trash, on its name's row (T53 item 4).
  await (await notebookAction(page, 'Trash', { role: 'link' })).click();
  const entry = page.getByTestId('trash').locator(`[data-note-id="${id}"]`);
  await expect(entry).toContainText(title);
  await expect(entry).toContainText(`from ${folder}`);
  // A git notebook keeps Trash until a person deletes for good: no 30 days (A828).
  await expect(entry).toContainText('kept until deleted for good');

  await entry.getByRole('button', { name: `Restore ${title}` }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${id}$`));
  await expect(body(page)).toHaveText('Keep for taxes');
  await expect(row).toHaveAttribute('aria-level', '2');

  // Again, then for good.
  await noteAction(page, 'delete-note');
  // The notebook's Trash, on its name's row (T53 item 4).
  await (await notebookAction(page, 'Trash', { role: 'link' })).click();
  await expect(entry).toBeVisible();
  await entry.getByRole('button', { name: `Delete ${title} for Good` }).click();
  await entry.getByRole('button', { name: 'Delete for Good' }).click();
  // The title is isolated (⁨…⁩), and the notebook's git history still keeps it (A828).
  await expect(page.getByTestId('trash-status')).toHaveText(
    `Deleted “⁨${title}⁩” for good. The repository’s git history still keeps it.`,
  );
  await expect(entry).toHaveCount(0);
  // Gone from the notebook once pushed: no rendered file, no note (A828). Git's history keeps
  // its old commits.
  await syncNow(page);
  await expect
    .poll(() => remoteFiles(host, remote).filter((path) => path.includes(id)), {
      timeout: 40_000,
    })
    .toEqual([]);
  expect(remoteMarkdown(host, remote, id)).toBeNull();
  const read = await readRemote(host, remote);
  expect(read.workspace.notes.map((note) => note.id)).not.toContain(id);
  expect(read.ops.note(id)).toBeUndefined();
  expect(errors).toEqual([]);
});
