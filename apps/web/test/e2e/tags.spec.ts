import { anotherMac, expect, seeded, test, type Page } from './fixtures';
import { NEW_NOTE } from './keys';
import { carried, syncNow } from './support/sync';

// T18: tags from text (#inline, nested a/b) and from the chips under the title (frontmatter),
// the tag pane and Search on a tag's notes, rename and merge through each note's document (offline too),
// and another Mac's tag pane following a change once git carries it (T59: a git notebook
// pushes 12 s after edits settle and pulls every minute, A1013, so the server's 5 s is gone;
// Sync Now on both sides carries it here).

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    // Requests made while the context is offline fail by design (as in offline.spec.ts).
    if (message.type() === 'error' && !/ERR_INTERNET_DISCONNECTED/.test(message.text())) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const pane = (page: Page) => page.getByTestId('tag-pane');
/** The pane's button for a tag with its note count. */
const tagButton = (page: Page, tag: string, count: number) =>
  pane(page).getByRole('button', {
    name: `#${tag}, ${count} ${count === 1 ? 'note' : 'notes'}`,
    exact: true,
  });
/** Every pane button for a tag or one nested under it, whatever the count. */
const anyTag = (page: Page, tag: string) =>
  pane(page).getByRole('button', { name: new RegExp(`^#${tag}(/|,)`) });

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

test('a tag opens Search on its notes, inline and frontmatter tags, nested levels included', async ({
  page,
}) => {
  const errors = collectErrors(page);
  const garden = `garden${RUN}`;
  await page.goto('/');
  await newNote(page, `Herbs ${RUN}`, `Sow basil #${garden}/herbs today`);
  // Inline tags show as tags in the text, never in code.
  await expect(body(page).locator('.pm-tag')).toHaveAttribute('data-tag', `${garden}/herbs`);
  // As chips (in the Info panel since T41), only frontmatter tags: an inline tag is not shown
  // twice (T36), even once the note list knows it (the tag pane lists it).
  await expect(anyTag(page, garden).first()).toBeVisible();
  await expect(page.getByTestId('note-tags').getByRole('list', { name: 'Tags' })).toHaveCount(0);
  await expect(
    page.getByTestId('note-tags').getByRole('button', { name: 'Add a Tag' }),
  ).toBeVisible();

  await newNote(page, `Beds ${RUN}`, 'Raised beds, no tag in the text');
  // A frontmatter tag from the chips (the Info panel, T41).
  await page.getByRole('button', { name: 'Add a Tag', exact: true }).click();
  const field = page.getByRole('combobox', { name: 'Add a tag' });
  await field.fill(`#${garden}`);
  await field.press('Enter');
  await expect(
    page.getByTestId('note-tags').getByRole('button', { name: `#${garden}`, exact: true }),
  ).toBeVisible();

  await newNote(page, `Untagged ${RUN}`, 'Nothing here');

  // The pane counts each note once per level; choosing a tag opens Search with its Tag filter
  // and no words, listing every note with it (finding 9 of the #192 review). The sidebar's
  // Notes section stays as it was.
  const top = tagButton(page, garden, 2);
  await expect(top).toBeVisible();
  await top.click();
  const search = page.getByTestId('search');
  await expect(search.getByRole('combobox', { name: 'Search notes' })).toHaveValue('');
  await expect(search.getByRole('combobox', { name: 'Tag' })).toHaveValue(garden);
  const hits = search.locator('.search-hit');
  await expect(hits).toHaveCount(2);
  await expect(hits.filter({ hasText: new RegExp(`Beds ${RUN}`) })).toHaveCount(1);
  await expect(hits.filter({ hasText: new RegExp(`Herbs ${RUN}`) })).toHaveCount(1);
  await expect(search).not.toContainText(`Untagged ${RUN}`);
  await expect(search.getByTestId('search-status')).toHaveText(`2 notes tagged #${garden}`);
  await expect(page.getByRole('tree', { name: 'Folders and notes' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);

  // ⌘-click (Ctrl-click) on an inline #tag in the text opens Search on it too.
  await top.click();
  await search
    .locator('.search-hit')
    .filter({ hasText: `Herbs ${RUN}` })
    .click();
  await expect(page.getByTestId('note-title')).toHaveValue(`Herbs ${RUN}`);
  await body(page)
    .locator('.pm-tag')
    .first()
    .click({ modifiers: ['ControlOrMeta'] });
  await expect(search.getByRole('combobox', { name: 'Tag' })).toHaveValue(`${garden}/herbs`);
  await expect(search.locator('.search-hit')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // A nested level lists its notes only.
  await pane(page)
    .getByRole('button', { name: `Expand #${garden}` })
    .click();
  await tagButton(page, `${garden}/herbs`, 1).click();
  await expect(search.locator('.search-hit')).toHaveCount(1);
  await expect(search.locator('.search-hit')).toContainText(`Herbs ${RUN}`);
  // Words narrow the tag's notes; Enter opens one.
  await search.getByRole('combobox', { name: 'Search notes' }).fill('basil');
  await expect(search.getByTestId('search-status')).toContainText('1 result');
  await page.keyboard.press('Escape');

  // A hit opens its note; that note's tag chip opens Search on its tag too.
  await top.click();
  await search
    .locator('.search-hit')
    .filter({ hasText: `Beds ${RUN}` })
    .click();
  await expect(search).toHaveCount(0);
  await expect(page.getByTestId('note-title')).toHaveValue(`Beds ${RUN}`);
  await page
    .getByTestId('note-tags')
    .getByRole('button', { name: `#${garden}`, exact: true })
    .click();
  await expect(search.getByRole('combobox', { name: 'Tag' })).toHaveValue(garden);
  await expect(search.locator('.search-hit')).toHaveCount(2);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('renaming a tag offline changes every note through its document, and syncs', async ({
  page,
  browser,
  context,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const old = `chore${RUN}`;
  const merged = `home${RUN}`;
  await page.goto('/');
  const open = await newNote(page, `Open chores ${RUN}`, `Sweep #${old} and #${merged}`);
  await newNote(page, `Closed chores ${RUN}`, `Mow #${old}/yard`);
  // Back to the first note in the app (a reload straight after typing is another test's subject).
  await page
    .getByRole('tree', { name: 'Folders and notes' })
    .getByRole('link', { name: `Open chores ${RUN}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/notes/${open}$`));
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(tagButton(page, old, 2)).toBeVisible();

  // Offline: merge #chore… into #home…, one note open in the editor, one only stored.
  host.network = 'down';
  await context.setOffline(true);
  await pane(page)
    .getByRole('button', { name: `Rename #${old}` })
    .click();
  const name = pane(page).getByRole('textbox', { name: `New name for #${old}` });
  await name.fill(merged);
  await pane(page).getByRole('button', { name: 'Merge' }).click();
  await expect(pane(page).getByRole('status')).toHaveText(
    `Merged #${old} into #${merged} in 2 notes`,
  );
  await expect(body(page)).toContainText(`Sweep #${merged} and #${merged}`);
  await expect(anyTag(page, old)).toHaveCount(0);
  await expect(tagButton(page, merged, 2)).toBeVisible();
  host.network = 'up';
  await context.setOffline(false);
  await syncNow(page);

  // Another Mac gets both notes changed (their documents, not just the index).
  const other = await anotherMac(browser, { remote: seeded(notebook).remote });
  try {
    const device = other.page;
    await device.goto('/');
    await expect(tagButton(device, merged, 2)).toBeVisible({ timeout: 40_000 });
    await pane(device)
      .getByRole('button', { name: `Expand #${merged}` })
      .click();
    await expect(tagButton(device, `${merged}/yard`, 1)).toBeVisible();
    await expect(anyTag(device, old)).toHaveCount(0);
  } finally {
    await other.context.close();
  }
  expect(errors).toEqual([]);
});

test("another Mac's tag pane follows a tag change once git carries it", async ({
  page,
  browser,
  notebook,
}) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  const fresh = `fresh${RUN}`;
  // This Mac makes the notebook on its first sync: pushed before the other Mac adds it.
  await page.goto('/');
  await syncNow(page);
  const other = await anotherMac(browser, { remote: seeded(notebook).remote });
  try {
    const device = other.page;
    await device.goto('/');
    await expect(pane(device)).toBeVisible();
    await newNote(page, `Watched ${RUN}`, 'Before');
    // In the tree (Recent Notes lists it too, T53 item 8).
    await carried(page, device, () =>
      expect(
        device.getByTestId('note-list').getByRole('link', { name: `Watched ${RUN}` }),
      ).toBeVisible(),
    );

    await page.getByTestId('note-body').locator('.ProseMirror').click();
    await page.keyboard.press('ControlOrMeta+ArrowDown');
    await page.keyboard.type(` #${fresh}`);
    await expect(tagButton(page, fresh, 1)).toBeVisible();
    await carried(page, device, () => expect(tagButton(device, fresh, 1)).toBeVisible());
  } finally {
    await other.context.close();
  }
  expect(errors).toEqual([]);
});
