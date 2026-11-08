import { anotherMac, expect, seeded, test, type Page } from './fixtures';
import { NEW_NOTE } from './keys';
import { storedRecord } from './stored';
import { readRemote, remoteMarkdown } from './support/remote';

// T6 on a git notebook (T59): create a note, edit it, reload it from IndexedDB before git
// answers, open it on a second Mac from the remote, and read its rendered markdown there.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

/** Creates a note through the UI and types a title and paragraphs; returns its id. */
async function createNote(
  page: Page,
  title: string,
  paragraphs: readonly string[],
): Promise<string> {
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  const id = ULID.exec(new URL(page.url()).pathname)![1]!;
  const titleField = page.getByTestId('note-title');
  await expect(titleField).toBeFocused();
  await page.keyboard.type(title);
  // No waiting: keys typed right after Enter must land in the body, not the title.
  await page.keyboard.press('Enter');
  for (const [i, paragraph] of paragraphs.entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(paragraph);
  }
  return id;
}

/** The notebook's sync dot: synced, nothing waiting to be pushed (A860). */
async function expectSynced(page: Page) {
  const dot = page.getByTestId('section-sync');
  await expect(dot).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });
  await expect(dot).toHaveAttribute('data-pending', '0', { timeout: 40_000 });
}

const TAG = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const WEEKEND = `Weekend plans ${TAG}`;
const SHOPPING = `Shared shopping list ${TAG}`;

const PARAGRAPHS = [
  'Saturday: farmers market, then the long trail loop.',
  'Sunday: slow breakfast and finish the bookshelf.',
  'Pack water, sunscreen and the camera.',
];

test('creates a note, edits it, and reloads it from IndexedDB before the network answers', async ({
  page,
  host,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toBeVisible();

  const id = await createNote(page, WEEKEND, PARAGRAPHS);
  await expect(body(page)).toBeFocused();
  await expect(page.getByTestId('note-title')).toHaveValue(WEEKEND);
  // The title edits live in the list.
  const listItem = page.getByTestId('note-list').getByRole('link', { name: WEEKEND });
  await expect(listItem).toHaveAttribute('aria-current', 'page');
  await expect(body(page)).toContainText(PARAGRAPHS[2]!);

  await expect.poll(async () => (await storedRecord(page, id))?.text).toBe(PARAGRAPHS.join('\n'));
  await expectSynced(page);

  // Git's network never answers: no fetch or push comes back.
  host.network = 'held';
  await page.reload();

  await expect(page.getByTestId('note-title')).toHaveValue(WEEKEND);
  for (const paragraph of PARAGRAPHS) await expect(body(page)).toContainText(paragraph);
  await expect(page.getByTestId('note-list').getByRole('link', { name: WEEKEND })).toBeVisible();
  await expect(page.getByTestId('section-sync')).not.toHaveAttribute('data-state', 'synced');

  host.network = 'up';
  await expectSynced(page);
  expect(errors).toEqual([]);
});

test('updates the list title live, starts untitled, and keeps notes apart', async ({ page }) => {
  const errors = collectErrors(page);
  // Its own tag: it counts the notes carrying it, and other tests in this worker share TAG.
  const tag = `${TAG}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/');
  const alpha = `Alpha ${tag}`;
  const first = await createNote(page, alpha, ['one']);
  await page.keyboard.press(NEW_NOTE);
  await expect(page).not.toHaveURL(new RegExp(first));
  await expect(page.getByTestId('note-title')).toBeFocused();
  await expect(page.getByTestId('note-title')).toHaveValue('');
  const list = page.getByTestId('note-list');
  const current = list.locator('a[aria-current="page"]');
  await expect(current).toHaveAccessibleName('Untitled');
  await expect(page).toHaveTitle('Untitled – Penmoss');

  await page.keyboard.type(`Beta ${tag}`);
  await expect(current).toHaveAccessibleName(`Beta ${tag}`);
  // The window or tab is named after the open note (B2).
  await expect(page).toHaveTitle(`Beta ${tag} – Penmoss`);

  // Typing straight after clicking New note lands in the new title (not on the button).
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await page.keyboard.type(`Gamma delta ${tag}`);
  await expect(page.getByTestId('note-title')).toHaveValue(`Gamma delta ${tag}`);
  await expect(list.getByRole('link', { name: new RegExp(tag) })).toHaveCount(3);

  await list.getByRole('link', { name: alpha }).click();
  await expect(page).toHaveURL(new RegExp(first));
  await expect(page.getByTestId('note-title')).toHaveValue(alpha);
  await expect(body(page)).toHaveText('one');
  await page.goBack();
  await expect(page.getByTestId('note-title')).toHaveValue(`Gamma delta ${tag}`);
  expect(errors).toEqual([]);
});

test('a second Mac lists a note from the remote, and opens it', async ({
  page,
  browser,
  notebook,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const id = await createNote(page, SHOPPING, ['Eggs', 'Coffee']);
  await expectSynced(page);

  // A second Mac with an empty IndexedDB adds the same remote.
  const other = await anotherMac(browser, { remote: seeded(notebook).remote });
  try {
    const device = other.page;
    const otherErrors = collectErrors(device);
    await device.goto('/');
    const item = device.getByTestId('note-list').getByRole('link', { name: SHOPPING });
    await expect(item).toBeVisible({ timeout: 40_000 });
    await item.click();
    await expect(device).toHaveURL(new RegExp(id));
    await expect(device.getByTestId('note-title')).toHaveValue(SHOPPING, {
      timeout: 10_000,
    });
    await expect(body(device)).toHaveText('EggsCoffee');
    await expectSynced(device);
    expect(otherErrors).toEqual([]);
  } finally {
    await other.context.close();
  }
  expect(errors).toEqual([]);
});

test('renders the note to markdown in the repository, and the notebook lists it', async ({
  page,
  host,
  notebook,
}) => {
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  await page.goto('/');
  const id = await createNote(page, 'Indexed note', PARAGRAPHS);
  await expectSynced(page);

  await expect
    .poll(() => remoteMarkdown(host, remote, id) ?? 'none', { timeout: 40_000 })
    .toContain(PARAGRAPHS[2]!);
  const markdown = remoteMarkdown(host, remote, id)!;
  expect(markdown).toContain(`id: ${id}`);
  expect(markdown).toContain('Indexed note');
  for (const paragraph of PARAGRAPHS) expect(markdown).toContain(paragraph);

  // Another device reads it from the notebook's own files.
  const read = await readRemote(host, remote);
  expect(read.workspace.notes.map((note) => note.id)).toContain(id);
  expect(read.title(id)).toBe('Indexed note');
  expect(errors).toEqual([]);
});
