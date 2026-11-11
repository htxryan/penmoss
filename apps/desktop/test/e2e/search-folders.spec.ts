import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  body,
  gitNotebook,
  launch,
  mainBounds,
  notebookSection,
  removeDataDirs,
  ULID,
  type Launched,
} from './support';

// PEN-71 (A1290, amending A1127) in the Mac app: with two git notebooks open and Notebook on
// All Notebooks, the search dialog's Folder list has both notebooks' folders, each under its
// notebook's name (AC1); picking one sets Notebook to that notebook (AC2); Tag lists both
// notebooks' tags (AC3). The web suite's search-folders.spec.ts covers the rest.

const mac = process.platform === 'darwin';
const SEARCH = mac ? 'Meta+Shift+KeyF' : 'Control+Shift+KeyF';
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

async function newFolder(page: Page, notebook: string, name: string): Promise<void> {
  const section = notebookSection(page, notebook);
  await (await action(section, 'New Folder')).click();
  const input = page.getByRole('textbox', { name: 'New folder name' });
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
  await expect(section.getByRole('treeitem', { name, exact: true })).toBeVisible();
}

async function newNote(page: Page, notebook: string, title: string, text: string): Promise<void> {
  await (await action(notebookSection(page, notebook), 'New Note in This Notebook')).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(body(page)).toContainText(text.split(' #')[0]!);
}

/** The groups of a select, each as its label and its options' labels. */
const groupsOf = (select: Locator) =>
  select.evaluate((element) =>
    [...element.querySelectorAll('optgroup')].map((group) => ({
      label: group.label,
      options: [...group.querySelectorAll('option')].map((option) => option.label),
    })),
  );

const optionLabels = (select: Locator) =>
  select.evaluate((element) =>
    [...(element as HTMLSelectElement).options].map((option) => option.label),
  );

const shown = (select: Locator) =>
  select.evaluate((element) => (element as HTMLSelectElement).selectedOptions[0]?.label ?? '');

test('search: Folder lists both notebooks’ folders by notebook; a pick switches Notebook', async () => {
  const launched = await launch();
  opened.push(launched);
  const { page, errors } = launched;
  await mainBounds(launched.app, { x: 0, y: 0, width: 1280, height: 720 });
  await gitNotebook(launched, 'Notes');
  await gitNotebook(launched, 'Work');

  await newFolder(page, 'Notes', 'Archive');
  await newFolder(page, 'Work', 'Projects');
  await newNote(page, 'Notes', 'Notes Moss', 'Moss at home #alpha ');
  await newNote(page, 'Work', 'Work Moss', 'Moss at work #beta ');

  await page.keyboard.press(SEARCH);
  const search = page.getByTestId('search');
  await search.getByRole('combobox', { name: 'Search notes' }).fill('moss');
  const hits = search.locator('.search-hit');
  await expect(hits.filter({ hasText: 'Notes Moss' })).toHaveCount(1, { timeout: 15_000 });
  await expect(hits.filter({ hasText: 'Work Moss' })).toHaveCount(1);
  const notebook = search.getByRole('combobox', { name: 'Notebook' });
  const folder = search.getByRole('combobox', { name: 'Folder' });
  const tag = search.getByRole('combobox', { name: 'Tag' });
  await expect.poll(() => shown(notebook)).toBe('All Notebooks');

  // AC1: All Folders, then each notebook's folders under its name, in the Notebook picker's order.
  const order = (await optionLabels(notebook)).slice(1);
  expect([...order].sort()).toEqual(['Notes', 'Work']);
  const expected = order.map((name) => ({
    label: name,
    options: [name === 'Notes' ? 'Archive' : 'Projects'],
  }));
  await expect.poll(() => groupsOf(folder)).toEqual(expected);
  expect((await optionLabels(folder))[0]).toBe('All Folders');
  // AC3: both notebooks' tags.
  await expect
    .poll(async () => [...(await optionLabels(tag))].sort())
    .toEqual(['#alpha', '#beta', 'Any Tag']);
  await page.waitForTimeout(1000);

  // AC2: a folder picked from Work's group sets Notebook to Work; Notes' note leaves the results.
  await folder.selectOption({ label: 'Projects' });
  await expect.poll(() => shown(notebook)).toBe('Work');
  await expect.poll(() => shown(folder)).toBe('Projects');
  await expect(hits.filter({ hasText: 'Notes Moss' })).toHaveCount(0);
  await expect.poll(() => groupsOf(folder)).toEqual([]);
  await folder.focus();
  // Held on the result for the recording.
  await page.waitForTimeout(2000);
  await expect.poll(() => shown(notebook)).toBe('Work');
  expect(errors).toEqual([]);
});
