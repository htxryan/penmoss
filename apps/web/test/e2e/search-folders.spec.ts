import { expect, test, type Locator, type Page } from './fixtures';

// PEN-71 (A-NEW-1, amending A1127): with two notebooks open and Notebook on All Notebooks, the
// search dialog's Folder list has every notebook's folders grouped under its name (AC1), picking
// one sets Notebook to its notebook (AC2), and Tag lists every notebook's tags (AC3). One
// notebook chosen lists its own alone (AC4); All Notebooks again groups them again (AC5).

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const EM = ' ';

test.use({
  seed: {
    name: 'Quanta',
    folders: ['Archive'],
    notes: [
      { title: 'Archived Moss', folder: 'Archive', markdown: 'Old moss. #alpha\n' },
      { title: 'Loose Moss', markdown: 'Moss anywhere.\n' },
    ],
  },
});

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

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
  select.evaluate((element) => {
    const chosen = (element as HTMLSelectElement).selectedOptions[0];
    return chosen ? chosen.label : '';
  });

test('Folder lists every notebook’s folders by notebook; a pick switches Notebook', async ({
  page,
  host,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(section(page, 'Quanta')).toBeVisible();
  await host.seed({
    name: 'Work',
    folders: ['Projects', 'Projects/Parser'],
    notes: [{ title: 'Parser Moss', folder: 'Projects/Parser', markdown: 'Parsing moss. #beta\n' }],
  });
  await expect(section(page, 'Work').getByTestId('section-sync')).toHaveAttribute(
    'data-state',
    'synced',
    { timeout: 40_000 },
  );
  // A Quanta note is open: under All Notebooks the lists are still every notebook's.
  await section(page, 'Quanta')
    .getByRole('tree', { name: 'Folders and notes' })
    .getByRole('link', { name: 'Loose Moss', exact: true })
    .click();
  await expect(page.getByTestId('note-title')).toHaveValue('Loose Moss');

  await page.keyboard.press('ControlOrMeta+Shift+KeyF');
  const search = page.getByTestId('search');
  await search.getByRole('combobox', { name: 'Search notes' }).fill('moss');
  const hits = search.locator('.search-hit');
  await expect(hits).toHaveCount(3);
  const notebook = search.getByRole('combobox', { name: 'Notebook' });
  const folder = search.getByRole('combobox', { name: 'Folder' });
  const tag = search.getByRole('combobox', { name: 'Tag' });
  await expect(notebook).toHaveValue('');

  // AC1: All Folders, then each notebook's folders under its name, subfolders indented.
  await expect
    .poll(() => groupsOf(folder))
    .toEqual([
      { label: 'Quanta', options: ['Archive'] },
      { label: 'Work', options: ['Projects', `${EM}Parser`] },
    ]);
  expect((await optionLabels(folder))[0]).toBe('All Folders');
  // AC3: every notebook's tags, each once.
  await expect.poll(() => optionLabels(tag)).toEqual(['Any Tag', '#alpha', '#beta']);
  await folder.focus();
  if (SHOTS) await search.screenshot({ path: `${SHOTS}/search-folders-grouped.png` });

  // AC4: one notebook chosen, its own folders with no heading and its own tags; a tag that is
  // not among them goes back to Any Tag.
  await tag.selectOption({ label: '#alpha' });
  await expect(hits).toHaveCount(1);
  await notebook.selectOption({ label: 'Work' });
  await expect(tag).toHaveValue('');
  await expect(folder).toHaveValue('');
  await expect.poll(() => groupsOf(folder)).toEqual([]);
  await expect.poll(() => optionLabels(folder)).toEqual(['All Folders', 'Projects', `${EM}Parser`]);
  await expect.poll(() => optionLabels(tag)).toEqual(['Any Tag', '#beta']);
  await expect(hits).toHaveCount(1);

  // AC5: All Notebooks again, and the folders grouped again.
  await notebook.selectOption({ label: 'All Notebooks' });
  await expect(folder).toHaveValue('');
  await expect.poll(() => groupsOf(folder)).toHaveLength(2);
  await expect(hits).toHaveCount(3);

  // AC2: a folder picked from Work's group sets Notebook to Work and narrows the results.
  await folder.selectOption({ label: 'Projects' });
  await expect.poll(() => shown(notebook)).toBe('Work');
  await expect.poll(() => shown(folder)).toBe('Projects');
  await expect(hits).toHaveCount(1);
  await expect(hits.first()).toContainText('Parser Moss');
  await expect.poll(() => groupsOf(folder)).toEqual([]);
  if (SHOTS) await search.screenshot({ path: `${SHOTS}/search-folders-picked.png` });
  // Held on the result for the recording.
  await page.waitForTimeout(2000);
  await expect(hits.first()).toContainText('Parser Moss');
  expect(errors).toEqual([]);
});
