// The sidebar’s sections: hidden, shown, moved, and the room they keep.
import { expect, type Page, test } from './fixtures';
import { collectErrors, newNote } from './support/app';
import { storedSetting } from './stored';
import { NEW_FOLDER } from './keys';

const RUN = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Shows or hides a sidebar section in Settings → Display (T62 item 11), then goes back. */
async function toggleSection(page: Page, section: string): Promise<void> {
  await page.getByTestId('sidebar-settings').click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByText('Display').click();
  await page.getByTestId(`display-section-${section}`).click();
  await page.goBack();
  await page.goBack();
  await expect(page.locator('#app-sidebar')).toBeVisible();
}
// T53, item 8.
test('sections hide, show and move from their titles and the ⋯ menu; Recent Notes lists the last notes', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const first = await newNote(page, `Recent one ${RUN}`, 'First.');
  const second = await newNote(page, `Recent two ${RUN}`, 'Second.');
  const recent = page.getByTestId('recent-notes');
  await expect(recent.getByTestId('recent-note').first()).toHaveAttribute(
    'href',
    `/notes/${second}`,
  );
  await expect(recent.getByTestId('recent-note').nth(1)).toHaveAttribute('href', `/notes/${first}`);
  await expect(page.getByTestId('notebooks').locator('.sb-section-name').first()).toHaveText(
    'Notebooks',
  );

  // Settings → Display shows or hides each (the sidebar's ⋯ menu moved there, T62 item 11).
  await expect(page.getByTestId('sidebar-more')).toHaveCount(0);
  await toggleSection(page, 'recent');
  await expect(page.getByTestId('sidebar-section-recent')).toHaveCount(0);
  await expect.poll(() => storedSetting(page, 'sidebar.hiddenSections')).toEqual(['recent']);
  await toggleSection(page, 'recent');
  await expect(page.getByTestId('sidebar-section-recent')).toBeVisible();

  // A title's ✕ hides its section; its handle moves it from the keyboard.
  const calendar = page.getByTestId('sidebar-section-calendar');
  await calendar.locator('.sb-section-head').first().hover();
  await calendar.getByTestId('section-hide').click();
  await expect(calendar).toHaveCount(0);
  await toggleSection(page, 'calendar');
  await expect(calendar).toBeVisible();

  const order = () =>
    page
      .locator('#app-sidebar .sb-part[data-section]')
      .evaluateAll((parts) => parts.map((part) => part.getAttribute('data-section')));
  const before = await order();
  const tags = page.getByTestId('sidebar-section-tags');
  // Shown while the title row is hovered or holds focus (Tab from the title reaches it).
  await tags.locator('.sb-section-head').first().hover();
  await tags.getByTestId('section-move').focus();
  await page.keyboard.press('ArrowUp');
  const moved = [...before];
  const at = moved.indexOf('tags');
  [moved[at - 1], moved[at]] = [moved[at]!, moved[at - 1]!];
  await expect.poll(order).toEqual(moved);
  // ↓ moves it back, and the handle keeps focus for another press.
  await page.keyboard.press('ArrowDown');
  await expect.poll(order).toEqual(before);
  await expect(tags.getByTestId('section-move')).toBeFocused();
  // Stored as it was.
  await expect.poll(() => storedSetting(page, 'sidebar.sectionOrder')).toEqual(before);
  // Hidden or collapsed, Notebooks still answers New Folder, and shows itself to name it.
  await toggleSection(page, 'notebooks');
  await expect(page.getByTestId('sidebar-section-notebooks')).toBeHidden();
  await page.keyboard.press(NEW_FOLDER);
  await expect(page.getByTestId('sidebar-section-notebooks')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New folder name' })).toBeFocused();
  await page.keyboard.press('Escape');
  const notebooksToggle = page.getByTestId('notebooks').locator('.sb-section-toggle').first();
  await notebooksToggle.click();
  await expect(notebooksToggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press(NEW_FOLDER);
  await expect(notebooksToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('textbox', { name: 'New folder name' })).toBeFocused();
  await page.keyboard.press('Escape');

  // The lines between sections run edge to edge.
  const part = (await tags.boundingBox())!;
  const sidebar = (await page.locator('#app-sidebar').boundingBox())!;
  expect(Math.abs(part.x - sidebar.x)).toBeLessThan(1.5);
  await expect.poll(() => storedSetting(page, 'sidebar.hiddenSections')).toEqual([]);
  expect(errors).toEqual([]);
});

const tree = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });

// T39 pass 2.
test('the sidebar list keeps room for its rows in a 900 px window', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(tree(page)).toBeVisible();
  // The Notebooks section of the sidebar (T53 item 8, A983). A git notebook's tree sits in its
  // own section under its name's row (T50), so the room is the section body's, the notebook's
  // tree in it.
  const listHeight = () =>
    page
      .locator('.sb-notebooks-body')
      .evaluate((element) => Math.round(element.getBoundingClientRect().height));
  await expect(page.locator('.sb-notebooks-body .sb-section-body > .folders')).toBeVisible();
  // 12rem: about six rows (it was 7.5rem, three rows, beside the calendar and the tags).
  expect(await listHeight()).toBeGreaterThanOrEqual(12 * 16);
  // A shorter window scrolls the sidebar as one, the list showing every row it has.
  await page.setViewportSize({ width: 1440, height: 820 });
  for (const selector of ['.sb-notebooks-body', '.sb-notebooks-body .sb-section-body > .folders']) {
    await expect
      .poll(() => page.locator(selector).evaluate((element) => getComputedStyle(element).overflowY))
      .toBe('visible');
  }
  expect(errors).toEqual([]);
});
