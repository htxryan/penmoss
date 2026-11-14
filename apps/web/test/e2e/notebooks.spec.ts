import { expect, test, type Page } from './fixtures';

// T43 on the Mac without a server (T59, D48, A912): a notebook is a git notebook. Two of them
// show side by side, each a section of the sidebar with its own tree and sync state; an open
// note is marked in its own notebook's tree; search finds notes in both. A git notebook holds no notebooks of
// its own (A912): no New Notebook, Turn into Notebook or Close on This Device. Settings → Git
// Notebooks removes one from this Mac (after Touch ID), and its section goes; the other stays.
// The personal workspace's notebooks (made from the palette, closed on a device, turned back
// into folders, mirrored) went with the server.

const RUN = `${Date.now().toString(36)}${100 + Math.floor(Math.random() * 900)}`;
const SEARCH = 'ControlOrMeta+Shift+KeyF';
const PALETTE = 'ControlOrMeta+KeyK';
const WORD = `quill${RUN}`;

test.use({
  seed: {
    name: 'Notes',
    folders: ['Errands'],
    notes: [{ title: `Errand ${RUN}`, markdown: `Buy ${WORD} ink.` }],
  },
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** A notebook's section of the sidebar: a region named for it. */
const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));
const treeIn = (page: Page, name: string) =>
  section(page, name).getByRole('tree', { name: 'Folders and notes' });

test('two git notebooks side by side: their own trees, search across both, and Remove', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const [errand] = notebook!.noteIds;
  // A second notebook on this Mac, from another repository.
  const work = await host.seed({
    name: 'Work',
    notes: [{ title: `Parser ${RUN}`, markdown: `The ${WORD} grammar.` }],
  });
  const [parser] = work.noteIds;
  await page.goto('/');

  // Each notebook is a section with its own tree and sync dot.
  for (const name of ['Notes', 'Work']) {
    await expect(section(page, name)).toBeVisible();
    await expect(section(page, name).getByTestId('section-sync')).toHaveAttribute(
      'data-state',
      'synced',
      { timeout: 40_000 },
    );
  }
  await expect(
    treeIn(page, 'Notes').getByRole('treeitem', { name: `Errand ${RUN}`, exact: true }),
  ).toBeVisible();
  await expect(
    treeIn(page, 'Work').getByRole('treeitem', { name: `Parser ${RUN}`, exact: true }),
  ).toBeVisible();
  await expect(
    treeIn(page, 'Notes').getByRole('treeitem', { name: `Parser ${RUN}`, exact: true }),
  ).toHaveCount(0);

  // An open note is marked in its own notebook's tree.
  await page.goto(`/notes/${parser}`);
  await expect(page.getByTestId('note-title')).toHaveValue(`Parser ${RUN}`);
  await expect(
    treeIn(page, 'Work').getByRole('link', { name: `Parser ${RUN}`, exact: true }),
  ).toHaveAttribute('aria-current', 'page');

  // Search finds the word in both notebooks.
  await page.keyboard.press(SEARCH);
  await page.getByTestId('search').getByRole('combobox', { name: 'Search notes' }).fill(WORD);
  const results = page
    .getByTestId('search')
    .getByRole('listbox', { name: 'Search results' })
    .getByRole('option');
  await expect
    .poll(async () =>
      (
        await results.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-note-id')))
      ).sort(),
    )
    .toEqual([errand, parser].sort());
  await page.keyboard.press('Escape');

  // No notebooks inside a git notebook (A912): not from the palette, not from a folder's menu.
  await page.goto('/');
  // The keyboard dispatcher attaches once the app has mounted.
  await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();
  await page.keyboard.press(PALETTE);
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('New Notebook');
  await expect(palette.getByRole('option', { name: /New Notebook/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await treeIn(page, 'Notes')
    .getByRole('treeitem', { name: 'Errands', exact: true })
    .click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Turn into Notebook' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Close on This Device' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Settings → Notebooks lists both; Work's own page removes it from this Mac; Notes stays.
  await page.goto('/settings/git-notebooks');
  await expect(page.getByTestId('git-notebook-row')).toHaveCount(2);
  await page.getByTestId('git-notebook-row').filter({ hasText: 'Work' }).click();
  await expect(page).toHaveURL(/\/settings\/git-notebooks\/[0-9A-Z]{26}$/);
  const card = page
    .getByTestId('git-notebook')
    .filter({ has: page.getByRole('heading', { name: 'Work' }) });
  await card.getByTestId('git-remove').click();
  const confirm = card.getByTestId('git-remove-confirm');
  if (await confirm.isVisible()) await confirm.getByTestId('git-remove-anyway').click();
  await expect(card).toHaveCount(0, { timeout: 20_000 });
  // Back to the list, which has Notes alone.
  await expect(page).toHaveURL(/\/settings\/git-notebooks$/);
  await expect(page.getByTestId('git-notebook-row')).toHaveCount(1);
  expect((await host.notebooks.list()).map((each) => each.name)).toEqual(['Notes']);
  await page.goto('/');
  await expect(section(page, 'Notes')).toBeVisible();
  await expect(section(page, 'Work')).toHaveCount(0);
  await page.goto(`/notes/${errand}`);
  await expect(page.getByTestId('note-title')).toHaveValue(`Errand ${RUN}`);
  expect(errors).toEqual([]);
});
