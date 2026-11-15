// Settings → Sidebar and Note (Display until PEN-146): the sidebar’s shortcuts and the title bar’s
// buttons.
import { expect, type Page, test } from './fixtures';
import { collectErrors, ULID } from './support/app';
import { pushed } from './support/sync';

// PEN-148: each of the title bar's buttons is one row, icon, name, then its switch at the end, in
// both columns and on a narrow window, where the grid is one column.
test('Settings → Note draws each title bar button on one row, its switch at the end', async ({
  page,
}) => {
  const errors = collectErrors(page);
  for (const width of [1440, 1000, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/settings/note');
    const cells = page.getByTestId('note-bar-settings').locator(':scope > .lf-row');
    await expect(cells).toHaveCount(9);
    const rows = await cells.evaluateAll((all) =>
      all.map((cell) => {
        const box = (el: Element) => el.getBoundingClientRect();
        const row = box(cell);
        const icon = box(cell.querySelector('.lf-row-label svg')!);
        const name = box(cell.querySelector('.lf-row-label')!);
        const toggle = box(cell.querySelector('[role="switch"]')!);
        const mid = (r: DOMRect) => r.top + r.height / 2;
        return {
          left: row.left,
          inOrder: icon.right <= toggle.left && name.right <= toggle.left,
          // The switch beside the name, not on a line of its own under it.
          beside: mid(toggle) > name.top && mid(toggle) < name.bottom,
          atEnd: row.right - toggle.right < 24,
        };
      }),
    );
    for (const row of rows)
      expect(row, `${width}px`).toMatchObject({ inOrder: true, beside: true, atEnd: true });
    const columns = new Set(rows.map((row) => Math.round(row.left))).size;
    expect(columns, `${width}px`).toBe(width < 700 ? 1 : 2);
  }
  expect(errors).toEqual([]);
});

// T42, item 7.
test('Settings → Sidebar hides sidebar shortcuts, on the rail too; Search stays', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/sidebar');
  const settings = page.getByTestId('display-settings');
  await expect(settings).toBeVisible();
  // Switches since PEN-146.
  const today = settings.getByRole('switch', { name: 'Today' });
  const graph = settings.getByRole('switch', { name: 'Graph' });
  await expect(settings.getByRole('switch', { name: /Search/ })).toBeDisabled();
  await expect(settings.getByRole('switch', { name: /Search/ })).toBeChecked();
  // Tags may be hidden too, and shows unless it is (R2-9).
  await expect(settings.getByTestId('display-tags')).toBeChecked();
  // Enabled once this device's copy of the settings is read: before, they are only defaults.
  await expect(today).toBeEnabled();
  const actions = page.locator('.sidebar .sb-actions');
  try {
    await expect(today).toBeChecked();
    await expect(graph).toBeChecked();
    await today.uncheck();
    await graph.uncheck();
    await expect(today).not.toBeChecked();

    // Synced: once the notebook has pushed them, after a reload the sidebar leaves them out,
    // expanded and as a rail. Back to the notes in the app, so the change is not cut off by a load.
    await page.locator('.settings-bar .back-link').click();
    await expect(actions.locator('[data-command="journal.today"]')).toHaveCount(0);
    await pushed(page);
    await page.reload();
    await expect(actions.locator('[data-command="app.search"]')).toBeVisible();
    await expect(actions.locator('[data-command="journal.thisWeek"]')).toBeVisible();
    await expect(actions.locator('[data-command="app.palette"]')).toBeVisible();
    await expect(actions.locator('[data-command="journal.today"]')).toHaveCount(0);
    await expect(actions.locator('[data-command="app.graph"]')).toHaveCount(0);
    await page.getByTestId('toggle-sidebar').click();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
    await expect(actions.locator('[data-command="app.search"]')).toBeVisible();
    // Tags, on by default, is on the rail too, right after Search (R2-9).
    await expect(
      actions.locator('[data-command="app.search"] + [data-command="app.tags"]'),
    ).toBeVisible();
    await expect(actions.locator('[data-command="journal.today"]')).toHaveCount(0);
    await expect(actions.locator('[data-command="app.graph"]')).toHaveCount(0);
    await page.getByTestId('toggle-sidebar').click();

    // A hidden shortcut's command still runs from the palette.
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.keyboard.type('Graph');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/graph/);
  } finally {
    await page.goto('/settings/sidebar');
    await expect(today).toBeEnabled();
    for (const box of [today, graph]) if (!(await box.isChecked())) await box.check();
    await expect(today).toBeChecked();
    await expect(graph).toBeChecked();
    // And synced again.
    await page.locator('.settings-bar .back-link').click();
    await expect(actions.locator('[data-command="journal.today"]')).toBeVisible();
    await expect(page.getByTestId('section-sync')).toHaveAttribute('data-state', 'synced', {
      timeout: 40_000,
    });
  }
  expect(errors).toEqual([]);
});

const SHOTS = process.env['PENMOSS_EVIDENCE'];

const LONG = Array.from({ length: 80 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n\n');

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

async function openNote(page: Page, title: string, notebook = 'Quanta'): Promise<void> {
  await section(page, notebook)
    .getByRole('tree', { name: 'Folders and notes' })
    .getByRole('link', { name: title, exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}
test.describe('in Quanta, with a folder, a long note and a source', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Miscellaneous'],
      notes: [
        { title: 'Penmoss Roadmap', markdown: 'Plans for Penmoss.\n' },
        { title: 'Long', markdown: `${LONG}\n` },
        { title: 'Source', markdown: '## Plan\n\nFirst line.\n' },
      ],
    },
  });

  // T66, item 5.
  test('the title bar’s buttons are chosen in Display, each also in ⋯', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await openNote(page, 'Source');
    // At the tab strip's end since PEN-140 (A1505).
    const bar = page.locator('.tab-strip-end .note-actions');
    // As before: Full Width and Copy Agent Reference, then ⋯.
    await expect(bar.locator('[data-note-bar]')).toHaveCount(2);
    await expect(bar.getByTestId('toggle-full-width')).toBeVisible();
    await expect(bar.getByTestId('copy-agent-reference')).toBeVisible();
    // Every button the bar can show is in ⋯, Full Width among them.
    await page.getByTestId('note-menu').click();
    const menu = page.getByRole('menu');
    for (const name of ['Full Width', 'Markdown Source']) {
      await expect(menu.getByRole('menuitemcheckbox', { name })).toHaveCount(1);
    }
    for (const name of [
      'Copy Note as Markdown',
      'Copy Note as Rich Text',
      'Copy Agent Reference',
      'Pin to Quick Access',
      'Open in New Window',
      'Move to Folder…',
      'Move to Trash',
    ]) {
      await expect(menu.getByRole('menuitem', { name })).toHaveCount(1);
    }
    await page.keyboard.press('Escape');

    await page.goto('/settings/note');
    const settings = page.getByTestId('note-bar-settings');
    await expect(settings.getByRole('switch')).toHaveCount(9);
    await settings.getByTestId('display-note-bar-copyAgentReference').uncheck();
    await settings.getByTestId('display-note-bar-toggleSource').check();
    await settings.getByTestId('display-note-bar-pinQuickAccess').check();
    if (SHOTS) await settings.screenshot({ path: `${SHOTS}/display-note-bar.png` });
    await page.goBack();
    await expect(page.getByTestId('note-title')).toHaveValue('Source');
    await expect(bar.locator('[data-note-bar]')).toHaveCount(3);
    await expect(bar.getByTestId('copy-agent-reference')).toHaveCount(0);
    // A chosen button runs its command and shows its state.
    const markdown = bar.getByTestId('note-bar-toggleSource');
    await markdown.click();
    await expect(markdown).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('note-markdown')).toBeVisible();
    await markdown.click();
    await bar.getByTestId('note-bar-pinQuickAccess').click();
    await expect(bar.getByTestId('note-bar-pinQuickAccess')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    if (SHOTS) await page.locator('.tab-strip').screenshot({ path: `${SHOTS}/note-bar.png` });
    expect(errors).toEqual([]);
  });
});
