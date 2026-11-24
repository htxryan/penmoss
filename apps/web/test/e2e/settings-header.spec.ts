// Every Settings page's header (A1560, Ryan's chosen design): "Settings (i)" and the page's title
// large, with no subtitle (PEN-182); scrolled past the title, the row pins with the title small after a slash.
import { expect, type Page, test } from './fixtures';
import { collectErrors } from './support/app';

const SHOTS = process.env['PENMOSS_EVIDENCE'];

const bar = (page: Page) => page.getByTestId('settings-head-bar');
const content = (page: Page) => page.locator('.settings-content');

test('the title shrinks into a pinned bar as the page scrolls, and back at the top', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto('/settings/appearance');
  const title = page.getByRole('heading', { level: 1, name: 'Appearance' });
  await expect(title).toBeVisible();
  // No subtitle under the title: Ryan finds them noise (PEN-182).
  await expect(page.getByTestId('settings-intro')).toHaveCount(0);
  // No "Settings" title over the menu: Search Settings is the menu's first row.
  await expect(page.locator('.settings-title')).toHaveCount(0);
  await expect(bar(page)).toContainText('Settings');
  // At the top: not pinned, the crumb hidden, no hairline.
  await expect(bar(page)).not.toHaveAttribute('data-pinned');
  await expect(page.getByTestId('settings-head-crumb')).toBeHidden();
  const at = await bar(page).boundingBox();

  await content(page).evaluate((element) => element.scrollTo({ top: 400 }));
  await expect(bar(page)).toHaveAttribute('data-pinned', '');
  await expect(page.getByTestId('settings-head-crumb')).toBeVisible();
  await expect(page.getByTestId('settings-head-crumb')).toHaveText('/Appearance');
  // The crumb is for the eye: the page's name is still its one heading.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  const pinned = await bar(page).boundingBox();
  // It stays where it was, the same height: nothing jumps.
  expect(pinned!.y).toBeCloseTo(at!.y, 0);
  expect(pinned!.height).toBeCloseTo(at!.height, 0);
  const style = await bar(page).evaluate((element) => {
    const css = getComputedStyle(element);
    return { border: css.borderBottomColor, shadow: css.boxShadow };
  });
  expect(style.shadow).not.toBe('none');
  expect(style.border).not.toBe('rgba(0, 0, 0, 0)');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-header-scrolled.png` });

  await content(page).evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(bar(page)).not.toHaveAttribute('data-pinned');
  await expect(page.getByTestId('settings-head-crumb')).toBeHidden();
  expect(errors).toEqual([]);
});

test('with reduced motion the bar pins without a transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto('/settings/appearance');
  const durations = await page
    .getByTestId('settings-head-crumb')
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(durations.split(',').every((each) => parseFloat(each) === 0)).toBe(true);
});

test('the (i) says where settings are kept, on hover and on focus, with a link', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/settings/sidebar');
  const info = page.getByRole('button', { name: 'About Settings' });
  const words = page.getByTestId('settings-home');
  await expect(info).toBeVisible();
  await expect(words).toBeHidden();
  // Its words are its description, so a screen reader hears them with its name.
  await expect(info).toHaveAccessibleDescription(
    /^Settings are synced through your primary notebook, .+\. Those marked with a laptop stay on this Mac only, and those marked with a monitor are kept for your Macs, apart from your phones\.$/,
  );

  // Hover shows it; it stays while the pointer crosses to its words.
  await info.hover();
  await expect(words).toBeVisible();
  await expect(words.getByRole('img', { name: 'with a laptop' })).toBeVisible();
  await expect(words.getByRole('img', { name: 'with a monitor' })).toBeVisible();
  await words.hover();
  await expect(words).toBeVisible();
  await page.mouse.move(1200, 700);
  await expect(words).toBeHidden();

  // The keyboard: focus shows it, Tab reaches the link, Escape closes it.
  // Onto it with the keyboard, from the control before it.
  await info.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(info).toBeFocused();
  await expect(words).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('settings-home-link')).toBeFocused();
  await expect(words).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-header-info.png` });
  await page.keyboard.press('Escape');
  await expect(words).toBeHidden();

  // The link opens the primary notebook's page.
  await info.click();
  await page.getByTestId('settings-home-link').click();
  await expect(page).toHaveURL(/\/settings\/git-notebooks\/.+/);
  await expect(page.getByTestId('git-primary-chip')).toBeVisible();
  expect(errors).toEqual([]);
});

test('every page and the search results open with the one header', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  for (const [path, name] of [
    ['/settings/appearance', 'Appearance'],
    ['/settings/sidebar', 'Sidebar'],
    ['/settings/note', 'Note'],
    ['/settings/symbols', 'Symbols'],
    ['/settings/journal', 'Daily Notes'],
    ['/settings/quick-capture', 'Quick Capture'],
    ['/settings/shortcuts', 'Keyboard Shortcuts'],
    ['/settings/git-notebooks', 'All Notebooks'],
    ['/settings/agents', 'Agents'],
    ['/settings/agent-activity', 'Agent Activity'],
    ['/settings/github', 'GitHub'],
    ['/settings/updates', 'Updates'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }), path).toHaveText(name);
    await expect(bar(page), path).toBeVisible();
    // No subtitle under the title (PEN-182): only a page's live state goes there.
    await expect(page.getByTestId('settings-intro'), path).toHaveCount(0);
  }
  await page.getByRole('searchbox', { name: 'Search Settings' }).fill('font');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Search Results');
  await expect(page.getByTestId('settings-intro')).toHaveText(/settings? match/);
  expect(errors).toEqual([]);
});
