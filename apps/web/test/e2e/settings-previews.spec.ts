// Settings' previews are the app itself (A1564): Sidebar's is the sidebar (`SidebarBody`),
// Appearance's and Note's are the app's own window and note view (`AppPreview`), the badge's is
// the sidebar's own row and the strip's own tab. Each is inert, and redraws as a setting changes.
// Appearance, Sidebar and Note are two tabs, Settings and Preview (A1633): the preview is on its
// own tab, as large as the page allows.
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

/** Shows a page's Settings or Preview tab (A1633). */
async function showTab(page: Page, name: 'Settings' | 'Preview'): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

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
  await showTab(page, 'Preview');
  const preview = page.getByTestId('sidebar-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('inert', '');
  // The app's own sections, with the notebook's own notes in them.
  const sections = preview.locator('.sb-part[data-section]');
  await expect(sections).toHaveCount(5);
  await expect(preview.getByTestId('sidebar-section-recent')).toContainText('Garden Plan');
  await expect(preview.getByTestId('source-section')).toContainText('Personal');
  await expect(preview.getByTestId('sidebar-shortcuts')).toBeVisible();
  // Hidden on Settings, gone on Preview; Graph off, its shortcut gone.
  await showTab(page, 'Settings');
  await page.getByTestId('display-section-recent').click();
  await expect(preview.getByTestId('sidebar-section-recent')).toHaveCount(0);
  await expect(sections).toHaveCount(4);
  await expect(preview.getByTestId('open-graph')).toHaveCount(1);
  await page.getByTestId('display-graph').click();
  await showTab(page, 'Preview');
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
  await showTab(page, 'Preview');
  const preview = page.getByTestId('note-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('inert', '');
  await expect(preview.getByTestId('note-title')).toHaveValue('Garden Plan');
  await expect(preview.locator('.sidebar')).toHaveCount(0);
  const buttons = preview.locator('[data-note-bar]');
  await expect(buttons).toHaveCount(2);
  expect(await buttons.evaluateAll((all) => all.map((each) => each.dataset['noteBar']))).toEqual([
    'fullWidth',
    'copyAgentReference',
  ]);
  await showTab(page, 'Settings');
  await page.getByTestId('display-note-bar-delete').click();
  await expect(preview.locator('[data-note-bar="delete"]')).toHaveCount(1);
  // A detail under the title: the note's own, as the app shows it.
  await page.getByTestId('metadata-title-edited').click();
  await showTab(page, 'Preview');
  await expect(preview.getByTestId('pinned-metadata')).toContainText('Edited');
  await expect(preview.getByTestId('status-bar')).toBeAttached();
  expect(errors).toEqual([]);
});

test('Settings → Appearance previews the app, and a theme shows in it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNote(page, 'Garden Plan');
  await page.goto('/settings/appearance');
  await showTab(page, 'Preview');
  const preview = page.getByTestId('app-preview');
  await expect(preview).toHaveAttribute('inert', '');
  await expect(preview.locator('.sidebar [data-testid="sidebar-shortcuts"]')).toBeVisible();
  await expect(preview.getByTestId('note-title')).toHaveValue('Garden Plan');
  const background = () =>
    preview.locator('.app-preview-window').evaluate((el) => getComputedStyle(el).backgroundColor);
  const before = await background();
  await showTab(page, 'Settings');
  await page.locator('label.theme-card[data-theme-id="nord"]').click();
  await showTab(page, 'Preview');
  await expect(page.getByTestId('appearance-preview-caption')).toContainText('Nord');
  await expect.poll(background).not.toBe(before);
  expect(errors).toEqual([]);
});

// A1582: under the window, the fonts at the size the app draws them, each labelled.
test('Settings → Appearance shows the fonts at their real size, and a size change shows in it', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/appearance');
  await showTab(page, 'Preview');
  const panel = page.getByTestId('type-specimen');
  await expect(panel).toBeVisible();
  const text = panel.locator('[data-specimen="Text"]');
  const label = (role: string) => panel.locator(`[data-specimen="${role}"] [data-specimen-label]`);
  // The note's own text at the Note Font Size, labelled with its family and size.
  await expect(text.locator('[data-specimen-text]')).toHaveCSS('font-size', '16px');
  await expect(label('Text')).toHaveText(/^Text · .+ · 16 px$/);
  await expect(label('Heading 1')).toHaveText(/ · 25\.6 px$/);
  await expect(label('Setting')).toHaveText(/^Setting · .+ · 13 px$/);

  await showTab(page, 'Settings');
  const fonts = page.getByTestId('font-settings');
  for (let step = 0; step < 4; step++) {
    await fonts.getByRole('button', { name: 'Larger' }).click();
  }
  await expect(fonts.getByTestId('note-size-value')).toHaveText('20 px');
  await showTab(page, 'Preview');
  await expect(text.locator('[data-specimen-text]')).toHaveCSS('font-size', '20px');
  await expect(label('Text')).toHaveText(/ · 20 px$/);
  await expect(label('Heading 1')).toHaveText(/ · 32 px$/);
  // The interface's text keeps its size; its font follows Interface Font.
  await expect(label('Setting')).toHaveText(/ · 13 px$/);
  const before = await label('Body').textContent();
  await showTab(page, 'Settings');
  await fonts.getByLabel('Interface Font', { exact: true }).selectOption('mono');
  await showTab(page, 'Preview');
  await expect(label('Body')).not.toHaveText(before ?? '');
  await expect(panel.locator('[data-specimen="Body"] [data-specimen-text]')).toHaveCSS(
    'font-family',
    /mono/i,
  );

  // Back as it was, for the next test.
  await showTab(page, 'Settings');
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
  await showTab(page, 'Preview');
  const panel = page.getByTestId('note-type-specimen');
  await expect(panel.locator('[data-specimen="Title"] [data-specimen-label]')).toHaveText(
    /^Title · .+ · 30\.4 px$/,
  );
  await expect(panel.locator('[data-specimen="Code"] [data-specimen-label]')).toHaveText(
    /^Code · /,
  );
  await expect(panel.locator('[data-specimen="Setting"]')).toHaveCount(0);
});

// A1633: Appearance, Sidebar and Note open on Settings; Preview shows the page's preview as
// large as the page allows (the tab is the larger view, so there is no Enlarge button), and ←
// and → move between the tabs. The tabs hold still under the header as the page scrolls.
test('Appearance, Sidebar and Note are two tabs, Settings and Preview', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNote(page, 'Garden Plan');
  for (const { path, name, preview } of [
    { path: 'appearance', name: 'Appearance', preview: 'app-preview' },
    { path: 'sidebar', name: 'Sidebar', preview: 'sidebar-preview' },
    { path: 'note', name: 'Note', preview: 'note-preview' },
  ]) {
    await page.goto(`/settings/${path}`);
    const tabs = page.getByRole('tablist', { name });
    const settings = tabs.getByRole('tab', { name: 'Settings' });
    const shown = tabs.getByRole('tab', { name: 'Preview' });
    await expect(settings).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId(preview)).toBeHidden();
    await expect(page.locator('[data-setting]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: `Enlarge ${name} Preview` })).toHaveCount(0);

    // The two tabs share the page's width.
    const [a, b] = [(await settings.boundingBox())!, (await shown.boundingBox())!];
    expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(1);

    await settings.focus();
    await page.keyboard.press('ArrowRight');
    await expect(shown).toBeFocused();
    await expect(shown).toHaveAttribute('aria-selected', 'true');
    const drawn = page.getByTestId(preview);
    await expect(drawn).toBeVisible();
    await expect(page.locator('[data-setting]').first()).toBeHidden();
    // As large as the page allows: far wider than the old 16 to 20rem column beside the controls.
    if (preview !== 'sidebar-preview') {
      expect((await drawn.boundingBox())!.width).toBeGreaterThan(500);
      await expect(drawn.getByTestId('note-title')).toHaveValue('Garden Plan');
    } else {
      await expect(drawn.getByTestId('sidebar-section-recent')).toContainText('Garden Plan');
    }
    const axe = await new AxeBuilder({ page })
      .include('.settings-section')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      axe.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => v.id),
    ).toEqual([]);
    await page.keyboard.press('ArrowLeft');
    await expect(settings).toHaveAttribute('aria-selected', 'true');
  }

  // The tabs stay under the header as the page scrolls.
  await page.goto('/settings/appearance');
  const tabs = page.getByRole('tablist', { name: 'Appearance' });
  const top = (await tabs.boundingBox())!.y;
  await page.evaluate(() => document.querySelector('.settings-content')?.scrollTo(0, 2000));
  await expect.poll(async () => (await tabs.boundingBox())!.y).toBeLessThan(top);
  await expect(tabs).toBeInViewport();
  expect(errors).toEqual([]);
});

// A1589: the badge's preview still opens larger: a magnifying glass on hover, a dialog that
// Close, Escape and the backdrop close, the focus back on the preview after.
test('a badge preview opens larger, and closes by Close, Escape and the backdrop', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/git-notebooks');
  const link = page.locator('a[href^="/settings/git-notebooks/"]').first();
  await expect(link).toBeAttached();
  const href = (await link.getAttribute('href'))!;
  await page.goto(href);
  const button = page.getByRole('button', { name: 'Enlarge Badge Preview' });
  const icon = button.locator('.preview-zoom-icon');
  await expect(icon).toHaveCSS('opacity', '0');
  await button.hover();
  await expect(icon).toHaveCSS('opacity', '1');

  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Badge Preview' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('badge-preview-large')).toContainText('Personal');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="badge-preview-zoom-dialog"]')
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
  await expect(page).toHaveURL(new RegExp(`${href}$`));
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
