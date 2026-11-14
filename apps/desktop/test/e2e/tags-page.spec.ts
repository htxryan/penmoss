import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  body,
  gitNotebook,
  go,
  launch,
  mainBounds,
  notebookSection,
  removeDataDirs,
  ULID,
  type Launched,
} from './support';

// PEN-68 in the Mac app (and finding 8 of Ryan's review of #192, design "Tags D"): the Tags page
// opens from the sidebar's Tags title row, lists each notebook's tags in a table with their
// counts, one table per notebook, and keeps each tag's description as it is typed. The web
// suite's tags-page.spec.ts covers renaming, merging and deleting tags. The web suite's tags-page.spec.ts covers the palette, the sidebar's
// tag filter and an agent reading the descriptions (describe_tags).

const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

/** A notebook's action on its name's row, shown while the pointer is over the row. */
async function action(section: Locator, name: string): Promise<Locator> {
  const head = section.locator('.sb-section-head:has(.tree-actions)').first();
  await head.scrollIntoViewIfNeeded();
  await head.hover();
  return head.locator('.tree-actions').getByRole('button', { name, exact: true });
}

/** A note at the notebook's top level, with its text. */
async function newNote(page: Page, notebook: string, title: string, text: string): Promise<void> {
  const section = notebookSection(page, notebook);
  await (await action(section, 'New Note in This Notebook')).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(body(page)).toContainText(text.split(' #')[0]!);
}

const tagsPage = (page: Page) => page.getByTestId('tags-page');
const region = (page: Page, name: string) =>
  tagsPage(page).getByRole('region', { name, exact: true });
const row = (scope: Locator, tag: string) => scope.locator(`.tags-row[data-tag="${tag}"]`);
/** A tag's description field, opened for editing (it shows one line until chosen). */
async function description(scope: Locator, tag: string): Promise<Locator> {
  const field = row(scope, tag).getByRole('textbox', { name: `Description of #${tag}` });
  if ((await field.count()) === 0) await row(scope, tag).locator('.tags-desc-view').click();
  await expect(field).toBeFocused();
  return field;
}

test('the Tags page lists each notebook’s tags and keeps what each means', async () => {
  test.setTimeout(180_000);
  const launched = await launch();
  opened.push(launched);
  const { page, errors } = launched;
  await mainBounds(launched.app, { x: 0, y: 0, width: 1280, height: 720 });
  await gitNotebook(launched, 'Notes');
  await gitNotebook(launched, 'Work');

  await newNote(page, 'Notes', 'Books', 'To read #reading ');
  await newNote(page, 'Work', 'Roadmap', 'Plans #project/penmoss ');
  await newNote(page, 'Work', 'Phone', 'The build #project/penmoss/android ');
  await go(page, '/');
  await expect(page.getByTestId('note-body')).toHaveCount(0);

  // From the Tags section's title row.
  const pane = page.getByTestId('tag-pane');
  const head = pane.getByTestId('tag-pane-toggle');
  await head.scrollIntoViewIfNeeded();
  await head.hover();
  await pane.getByRole('link', { name: 'Open the Tags Page' }).click();
  await expect(page).toHaveURL(/\/tags$/);

  // One table per notebook, a row per tag (and per level above one) with its count.
  const notes = region(page, 'Notes');
  const work = region(page, 'Work');
  await expect(row(notes, 'reading')).toBeVisible({ timeout: 30_000 });
  await expect(row(work, 'project').locator('.tags-count-cell')).toHaveText('2');
  await expect(work.locator('.tags-row[data-tag] .tags-name')).toHaveText([
    '#project',
    '#project/penmoss',
    '#project/penmoss/android',
  ]);

  // Descriptions save as they are typed, say so, and are there when the page opens again.
  await description(work, 'project');
  await page.keyboard.type('Work with an end.');
  await description(work, 'project/penmoss');
  await page.keyboard.type('The notes app itself.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Ship notes for it go here.');
  await expect(row(work, 'project/penmoss').getByTestId('tags-save')).toHaveText('Saved');
  await (await description(notes, 'reading')).fill('Books to read, and what I thought of them.');
  await page.keyboard.press('Escape');
  await go(page, '/');
  await expect(tagsPage(page)).toHaveCount(0);
  await go(page, '/tags');
  await expect(
    row(region(page, 'Work'), 'project').locator('.tags-desc-view .tags-desc-line'),
  ).toHaveText('Work with an end.');
  await expect(
    row(region(page, 'Notes'), 'reading').locator('.tags-desc-view .tags-desc-line'),
  ).toHaveText('Books to read, and what I thought of them.');
  const field = await description(region(page, 'Work'), 'project/penmoss');
  await expect(field).toHaveValue('The notes app itself.\nShip notes for it go here.');

  // Held on the page for the recording.
  await field.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  await expect(field).toBeVisible();
  expect(errors).toEqual([]);
});
