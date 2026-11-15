// What the sidebar’s tooltips say, and where there are none.
import { expect, type Page, test } from './fixtures';
import { collectErrors, newNote } from './support/app';

const RUN = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
// T42, item 4.
test('sidebar tips only add something: icon names, with their keys (A1119)', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Hover ${RUN}`, 'Hover my row.');
  const tooltip = page.getByTestId('tooltip');
  const sidebar = page.locator('.sidebar');

  // The shortcuts are icons (T51, A932), New Note too (T52): each one's tip names it, with its keys.
  for (const [selector, name] of [
    ['button[data-command="note.new"]', 'New Note'],
    ['.sb-graph', 'Graph'],
    ['[data-testid="open-search"]', 'Search'],
  ] as const) {
    await sidebar.locator(selector).hover();
    await expect(tooltip, selector).toHaveText(new RegExp(`^${name} \\(.+\\)$`));
    await page.mouse.move(900, 600);
  }

  // A note's row has none (Quanta feedback 2, A1119): the test below that says so rests the
  // pointer on one for longer than the tooltip delay.

  // The rail hides labels: there each item's tip names it, with its keys.
  await page.getByTestId('toggle-sidebar').click();
  try {
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
    await sidebar.locator('.sb-graph').hover();
    await expect(tooltip).toHaveText(/^Graph \(.+\)$/);
  } finally {
    await page.mouse.move(900, 600);
    await page.getByTestId('toggle-sidebar').click();
    await expect(page.getByTestId('app-root')).not.toHaveAttribute('data-sidebar', 'collapsed');
  }
  expect(errors).toEqual([]);
});

const SHOTS = process.env['PENMOSS_EVIDENCE'];

const LONG = Array.from({ length: 80 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n\n');

const tree = (page: Page) =>
  page
    .getByTestId('source-section')
    .and(page.getByRole('region', { name: 'Quanta', exact: true }))
    .getByRole('tree', { name: 'Folders and notes' });
test.describe('in Quanta, with a folder and a long note', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Miscellaneous'],
      notes: [{ title: 'Josh Onboarding' }, { title: 'Long', markdown: `${LONG}\n` }],
    },
  });

  // T65, items 2 and 3.
  test('a folder’s row shows New Note alone on hover; a note’s row has no tooltip', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const folder = tree(page).getByRole('treeitem', { name: 'Miscellaneous', exact: true });
    await expect(folder).toBeVisible({ timeout: 30_000 });
    await folder.hover();
    const actions = folder.locator('.row-actions');
    await expect(actions).toBeVisible();
    await expect(actions.getByRole('button')).toHaveCount(1);
    await expect(actions.getByRole('button', { name: 'New Note in Miscellaneous' })).toBeVisible();
    if (SHOTS) await folder.screenshot({ path: `${SHOTS}/folder-row.png` });
    // Rename and Delete stay in its menu.
    await folder.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Folder Miscellaneous' });
    await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Delete Folder…' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // A note's row: no tooltip, however long the pointer rests on it.
    const note = tree(page).getByRole('treeitem', { name: 'Josh Onboarding', exact: true });
    await expect(note).not.toHaveAttribute('data-tip');
    await note.hover();
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('tooltip')).toBeHidden();
    if (SHOTS) {
      const rows = await tree(page).boundingBox();
      if (rows) await page.screenshot({ path: `${SHOTS}/note-row-hover.png`, clip: rows });
    }
    expect(errors).toEqual([]);
  });
});
