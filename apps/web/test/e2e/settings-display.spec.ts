// Settings → Display: the sidebar’s shortcuts and the title bar’s buttons.
import { expect, type Page, test } from './fixtures';
import { collectErrors, ULID } from './support/app';
import { pushed } from './support/sync';

// T42, item 7.
test('Settings → Display hides sidebar shortcuts, on the rail too; Search stays', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/display');
  const settings = page.getByTestId('display-settings');
  await expect(settings).toBeVisible();
  const today = settings.getByRole('checkbox', { name: 'Today' });
  const graph = settings.getByRole('checkbox', { name: 'Graph' });
  await expect(settings.getByRole('checkbox', { name: /Search/ })).toBeDisabled();
  await expect(settings.getByRole('checkbox', { name: /Search/ })).toBeChecked();
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
    await page.goto('/settings/display');
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
    const bar = page.locator('.note-top .note-actions');
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

    await page.goto('/settings/display');
    const settings = page.getByTestId('note-bar-settings');
    await expect(settings.getByRole('checkbox')).toHaveCount(9);
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
    if (SHOTS) await page.locator('.note-top').screenshot({ path: `${SHOTS}/note-bar.png` });
    expect(errors).toEqual([]);
  });
});
