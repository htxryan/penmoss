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

// PEN-68 in the Mac app: the Tags page opens from the sidebar's Tags title row, lists each
// notebook's tags as a tree with their counts, one section per notebook, and keeps each tag's
// description as it is typed. The web suite's tags-page.spec.ts covers the palette, the sidebar's
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
const description = (scope: Locator, tag: string) =>
  scope.getByRole('textbox', { name: `Description of #${tag}`, exact: true });

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

  // One section per notebook, each a tree of its tags with counts.
  const notes = region(page, 'Notes');
  const work = region(page, 'Work');
  await expect(notes.getByRole('button', { name: '#reading, 1 note', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(work.getByRole('button', { name: '#project, 2 notes', exact: true })).toBeVisible();
  await expect(
    work.locator(
      '[data-tag="project"] [data-tag="project/penmoss"] [data-tag="project/penmoss/android"]',
    ),
  ).toHaveCount(1);

  // Descriptions save as they are typed, and are there when the page opens again.
  await description(work, 'project').click();
  await page.keyboard.type('Work with an end.');
  await description(work, 'project/penmoss').click();
  await page.keyboard.type('The notes app itself.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Ship notes for it go here.');
  await description(notes, 'reading').fill('Books to read, and what I thought of them.');
  await go(page, '/');
  await expect(tagsPage(page)).toHaveCount(0);
  await go(page, '/tags');
  const field = description(region(page, 'Work'), 'project/penmoss');
  await expect(field).toHaveValue('The notes app itself.\nShip notes for it go here.');
  await expect(description(region(page, 'Work'), 'project')).toHaveValue('Work with an end.');
  await expect(description(region(page, 'Notes'), 'reading')).toHaveValue(
    'Books to read, and what I thought of them.',
  );

  // Held on the page for the recording.
  await field.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  await expect(field).toBeVisible();
  expect(errors).toEqual([]);
});
