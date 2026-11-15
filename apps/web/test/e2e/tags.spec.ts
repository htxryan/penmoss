import { anotherMac, expect, type Page, seeded, test } from './fixtures';
import { carried, syncNow } from './support/sync';
import { body, collectErrors, newNote, ULID } from './support/app';

// T18: tags from text (#inline, nested a/b) and from the chips under the title (frontmatter),
// the tag pane and Search on a tag's notes, rename and merge through each note's document (offline too),
// and another Mac's tag pane following a change once git carries it (T59: a git notebook
// pushes 12 s after edits settle and pulls every minute, A1013, so the server's 5 s is gone;
// Sync Now on both sides carries it here).

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

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

test('a tag opens Search on its notes, inline and frontmatter tags, nested levels included', async ({
  page,
}) => {
  const errors = collectErrors(page, /ERR_INTERNET_DISCONNECTED/);
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
  const errors = collectErrors(page, /ERR_INTERNET_DISCONNECTED/);
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
  // The Tags page's words and its Undo (A1508).
  const done = page.getByTestId('tag-done-toast');
  await expect(done).toContainText(`Merged #${old} into #${merged} in 2 notes.`);
  await expect(done.getByRole('button', { name: 'Undo' })).toBeVisible();
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
  const errors = collectErrors(page, /ERR_INTERNET_DISCONNECTED/);
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

const info = (page: Page) => page.getByRole('complementary', { name: 'Metadata' });

async function openInfo(page: Page) {
  // Metadata's tab icon down the note's edge (T53 item 9): it opens the tab, or closes the panel
  // while that tab shows.
  const tab = page.getByTestId('note-tab-info');
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(info(page)).toBeVisible();
}
// T42, item 8.
test('Add a tag suggests every tag on any note, by keyboard too', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const tag = `sug${RUN}`;
  // A third tag the open note never gets, so the list still has something to offer at the
  // end, on a fresh workspace too.
  await newNote(page, `Tagged ${RUN}`, `Seeds #${tag}/beans, #${tag}x and #${tag}zz`);
  // The tag pane has the tags once the note's text is read.
  await expect(page.getByRole('button', { name: new RegExp(`^#${tag}x,`) })).toBeVisible();
  // The open note's own inline tag is on it already: never suggested (N6).
  await newNote(page, `Untagged ${RUN}`, `No tags yet but #${tag}inline here.`);
  await openInfo(page);
  const panel = info(page);
  await expect(panel.getByTestId('info-inline-tags')).toContainText(`#${tag}inline`);
  await panel.getByRole('button', { name: 'Add a Tag', exact: true }).click();
  const field = panel.getByRole('combobox', { name: 'Add a tag' });
  await expect(field).toBeFocused();
  // The browser's own form history never shows over it.
  await expect(field).toHaveAttribute('autocomplete', 'off');
  await expect(field).toHaveAttribute('aria-expanded', 'false');

  await field.pressSequentially(tag.slice(0, -2));
  const list = panel.getByRole('listbox', { name: 'Tags' });
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  await expect(list.getByRole('option')).toHaveText([`#${tag}/beans`, `#${tag}x`, `#${tag}zz`]);

  // ↓ chooses the first, ↓ the next, ↑ back; Enter adds the chosen one.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(list.getByRole('option', { name: `#${tag}x` })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowUp');
  await expect(list.getByRole('option', { name: `#${tag}/beans` })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(field).toHaveAttribute('aria-activedescendant', /.+/);
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: `#${tag}/beans`, exact: true })).toBeVisible();
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();

  // A note's own tags are not suggested again; a click adds one.
  await field.pressSequentially(tag);
  await expect(list.getByRole('option')).toHaveText([`#${tag}x`, `#${tag}zz`]);
  await list.getByRole('option', { name: `#${tag}x` }).click();
  await expect(panel.getByRole('button', { name: `#${tag}x`, exact: true })).toBeVisible();

  // Escape closes the list first, then the field.
  await field.pressSequentially(tag);
  await expect(list.getByRole('option')).toHaveText([`#${tag}zz`]);
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(field).toHaveAttribute('aria-expanded', 'false');
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe('in Quanta, with notes of links, lists and headings', () => {
  test.use({
    seed: {
      name: 'Quanta',
      notes: [
        { title: 'Links', markdown: 'See the docs here.\n' },
        {
          title: 'Outline',
          markdown: '1. one\n   1. two\n      1. three\n         1. four\n2. five\n',
        },
        { title: 'Lists', markdown: '1. one\n2. two\n3. three\n' },
        { title: 'Heading', markdown: 'first line\n\nsecond line\n' },
      ],
    },
  });

  // Ryan’s feedback of 6 Nov 2026 (Quanta), item 3.
  test('an empty Tags section says "No tags", centred and muted as "No notes" is', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    const empty = page.locator('#tag-pane-body');
    await expect(empty).toHaveText('No tags', { timeout: 30_000 });
    const style = await empty.evaluate((element) => {
      const s = getComputedStyle(element);
      return { align: s.textAlign, color: s.color };
    });
    const muted = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--pm-muted)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    expect(style).toEqual({ align: 'center', color: muted });
    expect(errors).toEqual([]);
  });
});

async function newNoteFromButtonAndEnter(page: Page, title: string, text = ''): Promise<string> {
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

// T39 pass 2.
test('Escape in the tag field gives focus back to Add a tag', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNoteFromButtonAndEnter(page, `Tags ${RUN}`, 'Text.');
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
