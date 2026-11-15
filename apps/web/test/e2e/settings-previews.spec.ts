// Settings' previews are the app itself (A1564): Sidebar's is the sidebar (`SidebarBody`),
// Appearance's and Note's are the app's own window and note view (`AppPreview`), the badge's is
// the sidebar's own row and the strip's own tab. Each is inert, and redraws as a setting changes.
import { expect, test, type Page } from './fixtures';
import { collectErrors } from './support/app';

test.use({
  seed: {
    name: 'Personal',
    notes: [
      { title: 'Garden Plan', markdown: '#garden\n\nRaised beds by the fence.\n' },
      { title: 'Reading List', markdown: 'Books for the winter.\n' },
    ],
  },
});

/** Opens a note, so it is the one this device opened last: the previews show it. */
async function openNote(page: Page, title: string): Promise<void> {
  await page.goto('/');
  const row = page.getByRole('link', { name: title }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByTestId('note-title').first()).toHaveValue(title, { timeout: 30_000 });
}

test('Settings → Sidebar previews the sidebar itself, and a change shows in it', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNote(page, 'Garden Plan');
  await page.goto('/settings/sidebar');
  const preview = page.getByTestId('sidebar-preview');
  await expect(preview).toHaveAttribute('inert', '');
  // The app's own sections, with the notebook's own notes in them.
  const sections = preview.locator('.sb-part[data-section]');
  await expect(sections).toHaveCount(5);
  await expect(preview.getByTestId('sidebar-section-recent')).toContainText('Garden Plan');
  await expect(preview.getByTestId('source-section')).toContainText('Personal');
  await expect(preview.getByTestId('sidebar-shortcuts')).toBeVisible();
  // Hidden here, gone there; Graph off, its shortcut gone.
  await page.getByTestId('display-section-recent').click();
  await expect(preview.getByTestId('sidebar-section-recent')).toHaveCount(0);
  await expect(sections).toHaveCount(4);
  await expect(preview.getByTestId('open-graph')).toHaveCount(1);
  await page.getByTestId('display-graph').click();
  await expect(preview.getByTestId('open-graph')).toHaveCount(0);
  // Inert: nothing in it takes a click or the focus.
  await expect(preview.locator(':focus')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Settings → Note previews the note itself: its bar buttons, details and status bar', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNote(page, 'Garden Plan');
  await page.goto('/settings/note');
  const preview = page.getByTestId('note-preview');
  await expect(preview).toHaveAttribute('inert', '');
  await expect(preview.getByTestId('note-title')).toHaveValue('Garden Plan');
  await expect(preview.locator('.sidebar')).toHaveCount(0);
  const buttons = preview.locator('[data-note-bar]');
  await expect(buttons).toHaveCount(2);
  expect(await buttons.evaluateAll((all) => all.map((each) => each.dataset['noteBar']))).toEqual([
    'fullWidth',
    'copyAgentReference',
  ]);
  await page.getByTestId('display-note-bar-delete').click();
  await expect(preview.locator('[data-note-bar="delete"]')).toHaveCount(1);
  // A detail under the title: the note's own, as the app shows it.
  await page.getByTestId('metadata-title-edited').click();
  await expect(preview.getByTestId('pinned-metadata')).toContainText('Edited');
  await expect(preview.getByTestId('status-bar')).toBeAttached();
  expect(errors).toEqual([]);
});

test('Settings → Appearance previews the app, and a theme shows in it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNote(page, 'Garden Plan');
  await page.goto('/settings/appearance');
  const preview = page.getByTestId('app-preview');
  await expect(preview).toHaveAttribute('inert', '');
  await expect(preview.locator('.sidebar [data-testid="sidebar-shortcuts"]')).toBeVisible();
  await expect(preview.getByTestId('note-title')).toHaveValue('Garden Plan');
  const background = () =>
    preview.locator('.app-preview-window').evaluate((el) => getComputedStyle(el).backgroundColor);
  const before = await background();
  await page.locator('label.theme-card[data-theme-id="nord"]').click();
  await expect.poll(background).not.toBe(before);
  expect(errors).toEqual([]);
});
