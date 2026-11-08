import { anotherMac, expect, seeded, test, type GitHost, type Page } from './fixtures';
import { NEW_FOLDER } from './keys';
import { notebookAction } from './notebook-actions';
import { syncNow } from './support/sync';
import { readRemote } from './support/remote';

// A674 end to end on a git notebook (T59): one Mac deletes a folder while another, offline
// too, files a note into it. Each delete moves only the notes it knew of, so the merge leaves
// the note in a folder that no longer exists. The server repaired that (moved it to the parent,
// listed it in the folder's Trash record); a git notebook has no server, so the note shows at the
// top level on both Macs, and restoring the folder puts it back.

const PALETTE = 'ControlOrMeta+KeyK';
const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

const treeOf = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });
const item = (page: Page, name: string) =>
  treeOf(page).getByRole('treeitem', { name, exact: true });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function synced(page: Page) {
  const dot = page.getByTestId('section-sync');
  await expect(dot).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });
  await expect(dot).toHaveAttribute('data-pending', '0', { timeout: 40_000 });
}

async function newFolder(page: Page, name: string, via: 'button' | 'shortcut') {
  if (via === 'button') await (await notebookAction(page, 'New Folder')).click();
  else await page.keyboard.press(NEW_FOLDER);
  const input = page.getByRole('textbox', { name: 'New folder name' });
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
  await expect(item(page, name)).toBeVisible();
}

/** The name of the folder the remote files `noteId` in, or null for the top level. */
async function remoteFolderOf(host: GitHost, remote: string, noteId: string) {
  const { workspace } = await readRemote(host, remote);
  const folderId = workspace.notes.find((note) => note.id === noteId)?.folderId ?? null;
  return folderId === null
    ? null
    : (workspace.folders.find((folder) => folder.id === folderId)?.name ?? `missing ${folderId}`);
}

test('a note filed into a folder another Mac deleted meanwhile shows at the top level on both, and comes back with it (A674 on git)', async ({
  page,
  browser,
  host,
  notebook,
}) => {
  test.setTimeout(240_000);
  const { remote } = seeded(notebook);
  const tag = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const parent = `Parent ${tag}`;
  const doomed = `Doomed ${tag}`;
  const stray = `Stray ${tag}`;
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(treeOf(page)).toBeVisible();
  await page.getByTestId('tree-root-drop').click();
  await newFolder(page, parent, 'button');
  await newFolder(page, doomed, 'shortcut');
  await page.getByTestId('tree-root-drop').click();
  await page
    .getByRole('button', { name: /^New Note/ })
    .first()
    .click();
  await expect(page).toHaveURL(ULID);
  const noteId = ULID.exec(page.url())![1]!;
  await page.keyboard.type(stray);
  await expect(item(page, stray)).toHaveAttribute('aria-level', '1');
  await syncNow(page);
  await synced(page);

  // The second Mac has it all, then both go offline.
  const other = await anotherMac(browser, { remote });
  const device = other.page;
  const otherErrors = collectErrors(device);
  try {
    await device.goto(`/notes/${noteId}`);
    await expect(item(device, stray)).toBeVisible({ timeout: 40_000 });
    await synced(device);
    for (const [view, mac] of [
      [page, host],
      [device, other.host],
    ] as const) {
      mac.network = 'down';
      await view.context().setOffline(true);
    }

    // The first deletes the folder; the second files the note into it. (No navigation while
    // offline: the dev server has no service worker.)
    await item(page, doomed).focus();
    await page.keyboard.press('Delete');
    const dialog = page.getByRole('dialog', { name: `Delete “${doomed}”?` });
    await dialog.getByRole('button', { name: 'Delete Folder' }).click();
    await expect(item(page, doomed)).toHaveCount(0);

    await device.keyboard.press(PALETTE);
    const palette = device.getByRole('dialog', { name: 'Command Palette' });
    await expect(palette).toBeVisible();
    await device.keyboard.type('Move to folder');
    await palette
      .getByRole('option', { name: /Move to Folder/ })
      .first()
      .click();
    const picker = device.getByRole('dialog', { name: `Move “${stray}” to a folder` });
    await expect(picker).toBeVisible();
    await device.keyboard.type(doomed.toLowerCase());
    await device.keyboard.press('Enter');
    await expect(device.getByTestId('move-status')).toHaveText(`Moved to ${parent} / ${doomed}`);

    // Both come back online: the merge files the note in the parent, on the remote and on both.
    for (const [view, mac] of [
      [page, host],
      [device, other.host],
    ] as const) {
      mac.network = 'up';
      await view.context().setOffline(false);
      await syncNow(view);
      await synced(view);
    }
    await syncNow(page);
    // Unlike the server, which repaired the tree after every change (A674: the note moved to
    // the parent and was listed in the folder's Trash record), nothing repairs a git notebook's
    // tree: the remote keeps the note filed in the deleted folder, and every client shows it at
    // the top level. (A gap reported with T59: `rehomeNotes` runs only on the server.)
    const doomedId = (await readRemote(host, remote)).workspace.notes.find(
      (note) => note.id === noteId,
    )?.folderId;
    expect(await remoteFolderOf(host, remote, noteId)).toBe(`missing ${doomedId}`);
    for (const view of [page, device]) {
      await expect(item(view, doomed)).toHaveCount(0);
      await expect(item(view, stray)).toHaveAttribute('aria-level', '1', { timeout: 20_000 });
    }

    // The folder's Trash record never heard of the note; restoring the folder puts it back all
    // the same, since the note is still filed there.
    await page.goto('/trash');
    const row = page.getByTestId('trash-folders').locator('li', { hasText: doomed });
    await expect(row).toContainText('0 notes');
    await row.getByRole('button', { name: `Restore the folder ${doomed}` }).click();
    await expect(page.getByTestId('trash-status')).toContainText(`Restored “${doomed}”`);
    await syncNow(page);
    await expect.poll(() => remoteFolderOf(host, remote, noteId), { timeout: 40_000 }).toBe(doomed);
    await page.goto('/');
    await item(page, parent).focus();
    if ((await item(page, parent).getAttribute('aria-expanded')) === 'false') {
      await page.keyboard.press('ArrowRight');
    }
    await item(page, doomed).focus();
    if ((await item(page, doomed).getAttribute('aria-expanded')) === 'false') {
      await page.keyboard.press('ArrowRight');
    }
    await expect(item(page, stray)).toHaveAttribute('aria-level', '3');
    expect(errors).toEqual([]);
    expect(otherErrors).toEqual([]);
  } finally {
    await other.context.close();
  }
});
