import { expect, test, type GitHost, type Page } from './fixtures';
import { NEW_NOTE } from './keys';
import { storedDocumentText, storedRecord, storedSetting } from './stored';
import { syncNow } from './support/sync';

// A626: a change made just before the page goes (reload, tab closed) is kept on this device,
// even with the server out of reach. Until A626 the page-hide write read the record first and
// wrote in the read's callback, which never ran once the page was unloading: a note edit or a
// workspace change made in the last moment was gone from the device, and offline, gone. (Even a
// write with no read first, committed at once, was lost with the page about one time in eight:
// the change is kept in local storage instead, and merged into the record on the next open.)
//
// Here the remote never gets the change (T59: a git notebook): git's network is down, so no
// fetch or push gets through, and after the reload only this device's stored copy can hold it.
//
// The note reaches the remote before the network goes by Sync Now (A1013), not by waiting out
// the push delay (12 s): a test that waited for it twice spent most of its 30 s on the two
// waits, and under the parallel suite's load ran out of time in the second.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

/** A new note, its title ready for typing (A1179: at once, no wait for its focus); its id. */
async function newNote(page: Page): Promise<string> {
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

/** The notebook's dot says everything is pushed, as it does once a push lands on its own. */
async function synced(page: Page) {
  const dot = page.getByTestId('section-sync');
  await expect(dot).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });
  await expect(dot).toHaveAttribute('data-pending', '0', { timeout: 40_000 });
}

/** Pushes what this device holds now (Sync Now), then waits until nothing is left to push. */
async function pushNow(page: Page) {
  await syncNow(page);
  await synced(page);
}

/** From now on, nothing reaches the remote: every fetch and push fails as with no network. */
function cutSync(host: GitHost) {
  host.network = 'down';
}

test('a note edit made just before a reload is kept on this device, with the remote out of reach', async ({
  page,
  host,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toBeVisible();
  const id = await newNote(page);
  await page.keyboard.type(`Unload ${RUN}`);
  await page.keyboard.press('Enter');
  await page.keyboard.type(`First line ${RUN}`);
  await expect(page.getByTestId('note-title')).toHaveValue(`Unload ${RUN}`);
  await expect(body(page)).toContainText(`First line ${RUN}`);
  await pushNow(page);

  cutSync(host);
  await page.reload();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(body(page)).toContainText(`First line ${RUN}`);
  await body(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(` and the last words ${RUN}`);
  await expect(body(page)).toContainText(`the last words ${RUN}`);
  // At once: before the 200 ms write, as when a tab is closed or reloaded mid-sentence.
  await page.reload();

  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(body(page)).toContainText(`the last words ${RUN}`);
  expect((await storedRecord(page, id))?.text).toContain(`the last words ${RUN}`);
});

test('a note edit stored just before a reload, before its text was refreshed, is found in the stored text', async ({
  page,
  host,
}) => {
  // A695: while typing, a write reuses the text the last one described (it is refreshed once a
  // text interval). A page that went after such a write and before the refresh kept nothing
  // new, and the stored text (offline search, the note list) stayed without the last words.
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toBeVisible();
  const id = await newNote(page);
  await page.keyboard.type(`Described ${RUN}`);
  await pushNow(page);

  cutSync(host);
  await page.reload();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await body(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  // The first write describes the text; the second, moments later, reuses that description.
  await page.keyboard.type(`Almost ${RUN}`);
  await expect.poll(() => storedDocumentText(page, id)).toContain(`Almost ${RUN}`);
  await page.keyboard.type(` the last words`);
  await expect.poll(() => storedDocumentText(page, id)).toContain(`Almost ${RUN} the last words`);
  await page.reload();

  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(body(page)).toContainText(`Almost ${RUN} the last words`);
  expect((await storedRecord(page, id))?.text).toContain(`Almost ${RUN} the last words`);
});

test('a workspace setting changed just before a reload is kept on this device, with the remote out of reach', async ({
  context,
  page,
  host,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toBeVisible();
  await newNote(page);
  await page.keyboard.type(`Width ${RUN}`);
  await pushNow(page);
  const toggle = page.getByTestId('toggle-full-width');

  cutSync(host);
  await page.reload();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.reload();

  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  // A git notebook keeps this device's settings in its own WorkspaceDoc (`device`, A827),
  // written to the stored copy at once: there is no server state to wait for (the server's
  // held settings, A810, went with it). It is what the page shows once it has loaded.
  await expect.poll(() => storedSetting(page, 'note.fullWidth'), { timeout: 5_000 }).toBe(true);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // Another window of this Mac shows it too, and pushes it once the network is back.
  await page.close();
  host.network = 'up';
  const back = await context.newPage();
  await back.setViewportSize({ width: 1600, height: 900 });
  await back.goto('/');
  await expect(back.getByTestId('app-root')).toBeVisible();
  await back.getByRole('button', { name: /^New Note/ }).click();
  await expect(back).toHaveURL(ULID);
  await expect(back.getByTestId('toggle-full-width')).toHaveAttribute('aria-pressed', 'true');
  await synced(back);
});
