// Settings' previews are the app itself (A1564): Sidebar's is the sidebar (`SidebarBody`),
// Appearance's and Note's are the app's own window and note view (`AppPreview`), the badge's is
// the sidebar's own row and the strip's own tab. Each is inert, and redraws as a setting changes.
import AxeBuilder from '@axe-core/playwright';
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

// A1582: beside the shrunk window, the fonts at the size the app draws them, each labelled.
test('Settings → Appearance shows the fonts at their real size, and a size change shows in it', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/appearance');
  const panel = page.getByTestId('type-specimen');
  await expect(panel).toBeVisible();
  const text = panel.locator('[data-specimen="Text"]');
  const label = (role: string) => panel.locator(`[data-specimen="${role}"] [data-specimen-label]`);
  // The note's own text at the Note Font Size, labelled with its family and size.
  await expect(text.locator('[data-specimen-text]')).toHaveCSS('font-size', '16px');
  await expect(label('Text')).toHaveText(/^Text · .+ · 16 px$/);
  await expect(label('Heading 1')).toHaveText(/ · 25\.6 px$/);
  await expect(label('Setting')).toHaveText(/^Setting · .+ · 13 px$/);

  const fonts = page.getByTestId('font-settings');
  for (let step = 0; step < 4; step++) {
    await fonts.getByRole('button', { name: 'Larger' }).click();
  }
  await expect(fonts.getByTestId('note-size-value')).toHaveText('20 px');
  await expect(text.locator('[data-specimen-text]')).toHaveCSS('font-size', '20px');
  await expect(label('Text')).toHaveText(/ · 20 px$/);
  await expect(label('Heading 1')).toHaveText(/ · 32 px$/);
  // The interface's text keeps its size; its font follows Interface Font.
  await expect(label('Setting')).toHaveText(/ · 13 px$/);
  const before = await label('Body').textContent();
  await fonts.getByLabel('Interface Font', { exact: true }).selectOption('mono');
  await expect(label('Body')).not.toHaveText(before ?? '');
  await expect(panel.locator('[data-specimen="Body"] [data-specimen-text]')).toHaveCSS(
    'font-family',
    /mono/i,
  );

  // Back as it was, for the next test.
  await fonts.getByLabel('Interface Font', { exact: true }).selectOption('theme');
  for (let step = 0; step < 4; step++) {
    await fonts.getByRole('button', { name: 'Smaller' }).click();
  }
  await expect(fonts.getByTestId('note-size-value')).toHaveText('16 px');
  expect(errors).toEqual([]);
});

test('Settings → Note shows the note’s text at its real size', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/note');
  const panel = page.getByTestId('note-type-specimen');
  await expect(panel.locator('[data-specimen="Title"] [data-specimen-label]')).toHaveText(
    /^Title · .+ · 30\.4 px$/,
  );
  await expect(panel.locator('[data-specimen="Code"] [data-specimen-label]')).toHaveText(
    /^Code · /,
  );
  await expect(panel.locator('[data-specimen="Setting"]')).toHaveCount(0);
});

// A1589: a preview opens larger: a magnifying glass on hover, a dialog that Close, Escape and
// the backdrop close, the focus back on the preview after.
test('a Settings preview opens larger, and closes by Close, Escape and the backdrop', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNote(page, 'Garden Plan');
  await page.goto('/settings/appearance');
  const button = page.getByRole('button', { name: 'Enlarge Appearance Preview' });
  const icon = button.locator('.preview-zoom-icon');
  await expect(icon).toHaveCSS('opacity', '0');
  await button.hover();
  await expect(icon).toHaveCSS('opacity', '1');
  const small = (await page.getByTestId('app-preview').boundingBox())!;

  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Appearance Preview' });
  await expect(dialog).toBeVisible();
  const large = dialog.getByTestId('app-preview-large');
  await expect(large).toHaveAttribute('inert', '');
  await expect(large.getByTestId('note-title')).toHaveValue('Garden Plan');
  const big = (await large.boundingBox())!;
  expect(big.width).toBeGreaterThan(small.width * 2);
  // The whole window shows: no taller than the dialog leaves room for.
  expect(big.y + big.height).toBeLessThanOrEqual(900);
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="app-preview-zoom-dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
  // Tab stays in the dialog.
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();

  // Escape closes it, the page stays, and the focus is back on the preview.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(button).toBeFocused();

  // From the keyboard: Return opens it; Close closes it.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();

  // A click on the backdrop closes it.
  await button.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the Sidebar, Note and badge previews open larger, each the page’s own preview', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNote(page, 'Garden Plan');
  await page.goto('/settings/sidebar');
  await page.getByRole('button', { name: 'Enlarge Sidebar Preview' }).click();
  const sidebar = page.getByRole('dialog', { name: 'Sidebar Preview' });
  await expect(sidebar.getByTestId('sidebar-preview-large')).toBeVisible();
  await expect(sidebar.getByTestId('sidebar-section-recent')).toContainText('Garden Plan');
  await page.keyboard.press('Escape');

  await page.goto('/settings/note');
  await page.getByRole('button', { name: 'Enlarge Note Preview' }).click();
  const note = page.getByRole('dialog', { name: 'Note Preview' });
  const large = note.getByTestId('note-preview-large');
  await expect(large.getByTestId('note-title')).toHaveValue('Garden Plan');
  await expect(large.locator('[data-note-bar]')).toHaveCount(2);
  await page.keyboard.press('Escape');

  await page.goto('/settings/git-notebooks');
  const link = page.locator('a[href^="/settings/git-notebooks/"]').first();
  await expect(link).toBeAttached();
  await page.goto((await link.getAttribute('href'))!);
  await page.getByRole('button', { name: 'Enlarge Badge Preview' }).click();
  const badge = page.getByRole('dialog', { name: 'Badge Preview' });
  await expect(badge.getByTestId('badge-preview-large')).toContainText('Personal');
  await page.keyboard.press('Escape');
  await expect(badge).toHaveCount(0);
  expect(errors).toEqual([]);
});
