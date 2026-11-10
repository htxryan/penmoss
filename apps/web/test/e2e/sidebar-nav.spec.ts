import { expect, test, type Page } from './fixtures';
import { notebookAction } from './notebook-actions';

// T51 (web): the sidebar's shell and the app's navigation. Back and Forward through the app's own
// pages (A943); the shortcuts as one row of icons (A932); each source's sync state as a dot
// (A933); the Tags panel collapsing, remembered on this device (A934); the footer's icons
// (A935); and Settings, whose content alone scrolls (A942). On a git notebook (T59): its own
// Trash (`/trash?source=<id>`), its dot on its section's row, leading to Settings → Git Notebooks.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
/** A git notebook's own Trash. */
const TRASH = /\/trash\?source=[0-9A-Z]{26}$/;
const RUN = `sn${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function newNote(page: Page, title: string, text = ''): Promise<string> {
  await page
    .getByRole('button', { name: /^New note/i })
    .first()
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  if (text) await page.keyboard.type(text);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

test('Back and Forward step through the app’s pages, greyed out at either end (A943)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const back = page.getByTestId('app-back');
  const forward = page.getByTestId('app-forward');
  // A fresh page: nowhere to go either way.
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();
  await expect(back).toHaveAccessibleName('Back');
  await expect(forward).toHaveAccessibleName('Forward');

  const id = await newNote(page, `Back ${RUN}`, 'Somewhere to come back to.');
  await expect(back).toBeEnabled();
  await page.getByTestId('open-graph').click();
  await expect(page).toHaveURL(/\/graph/);
  // The notebook's Trash, on its name's row (T53 item 4).
  const trash = await notebookAction(page, 'Trash', { role: 'link' });
  await expect(trash).toHaveAttribute('data-testid', /^(sidebar|section)-trash$/);
  await trash.click();
  await expect(page).toHaveURL(TRASH);
  await page.getByTestId('sidebar-settings').click();
  await expect(page).toHaveURL(/\/settings/);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: /^Display$/i })
    .click();
  await expect(page).toHaveURL(/\/settings\/display$/);
  await expect(forward).toBeDisabled();

  // Back, from Settings' own bar, through every page in turn.
  await back.click();
  await expect(page).not.toHaveURL(/\/settings\/display$/);
  await expect(page).toHaveURL(/\/settings/);
  await expect(forward).toBeEnabled();
  await back.click();
  await expect(page).toHaveURL(TRASH);
  await back.click();
  await expect(page).toHaveURL(/\/graph/);
  await back.click();
  await expect(page).toHaveURL(new RegExp(`/notes/${id}$`));
  await expect(page.getByTestId('note-title')).toHaveValue(`Back ${RUN}`);

  // And Forward again, to the end.
  await forward.click();
  await expect(page).toHaveURL(/\/graph/);
  await forward.click();
  await expect(page).toHaveURL(TRASH);
  await forward.click();
  await forward.click();
  await expect(page).toHaveURL(/\/settings\/display$/);
  await expect(forward).toBeDisabled();

  // The browser's own Back agrees: one history.
  await page.goBack();
  await expect(page).toHaveURL(/\/settings$|\/settings\/appearance$/);
  await expect(forward).toBeEnabled();

  // Each button names itself with its keys.
  await back.hover();
  await expect(page.getByTestId('tooltip')).toHaveText(/^Back \(.+\)$/);
  expect(errors).toEqual([]);
});

test('the sidebar: a row of shortcut icons, a sync dot, icons in the footer (A932, A933, A935)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await newNote(page, `Dot ${RUN}`, 'Text.');
  const sidebar = page.getByRole('complementary', { name: 'Notes' });
  const tooltip = page.getByTestId('tooltip');

  // One row, New Note first (T52), each icon named, its keys in its tooltip.
  const row = sidebar.getByTestId('sidebar-shortcuts');
  const names = ['New Note', 'Search', 'Today', 'This Week', 'Graph', 'Commands'];
  const tops = new Set<number>();
  for (const name of names) {
    const item = row
      .getByRole('button', { name, exact: true })
      .or(row.getByRole('link', { name, exact: true }));
    await expect(item).toBeVisible();
    tops.add(Math.round((await item.boundingBox())!.y));
  }
  expect(tops.size).toBe(1);
  await row.getByRole('button', { name: 'Today', exact: true }).hover();
  await expect(tooltip).toHaveText(/^Today \(.+\)$/);
  await page.mouse.move(900, 600);

  // No pill at the top: the notebook's row has a dot, its words in its tooltip.
  await expect(sidebar.locator('.sync-pill')).toHaveCount(0);
  const heading = sidebar.getByTestId('source-section').locator('.sb-section-head');
  await expect(heading.locator('.sb-section-name')).toHaveText('Notes');
  const dot = heading.getByTestId('section-sync');
  await expect(dot).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });
  await expect(dot).toHaveAttribute('data-pending', '0', { timeout: 40_000 });
  await expect(dot).toHaveText('');
  await expect(dot).toHaveAccessibleName('Sync status: Synced');
  // The list may have scrolled to the new note: bringing the header back scrolls it, and a
  // scroll hides a tooltip (A189), so hover once it has stopped.
  await expect(async () => {
    await page.mouse.move(900, 600);
    await dot.hover();
    await expect(tooltip).toHaveText('Synced', { timeout: 4_000 });
  }).toPass();
  await page.mouse.move(900, 600);
  // It leads to the notebook's page in Settings → Git Notebooks, which says more (A860, A1098).
  await dot.click();
  await expect(page).toHaveURL(/\/settings\/git-notebooks\/[0-9A-Z]{26}$/);
  await expect(page.getByTestId('git-status')).toBeVisible();
  await page.goBack();

  // The footer: icons, each named, with its tooltip. Trash is on the notebook's bar (T52).
  const foot = sidebar.locator('.sb-foot');
  await expect(foot.getByRole('link', { name: 'Trash', exact: true })).toHaveCount(0);
  for (const [name, role, where] of [
    ['Settings', 'link', foot],
    ['Send Feedback', 'button', foot],
    ['Trash', 'link', sidebar.locator('.tree-actions')],
  ] as const) {
    const item = where.getByRole(role, { name, exact: true });
    // Trash is on the notebook's row since T53, shown on hover.
    if (name === 'Trash') await heading.hover();
    await expect(item).toBeVisible();
    await expect(item).toHaveText('');
    // Trash sits in the scrolling list now: hovering it may scroll the list back to the top,
    // and a scroll hides a tooltip (A189), so hover again once it has stopped (as for the dot).
    await expect(async () => {
      await page.mouse.move(900, 600);
      if (name === 'Trash') await heading.hover();
      await item.hover();
      await expect(tooltip).toHaveText(new RegExp(`^${name}( \\(.+\\))?$`), { timeout: 4_000 });
    }).toPass();
    await page.mouse.move(900, 600);
  }
  expect(errors).toEqual([]);
});

test('the Tags panel collapses, and stays so on this device (A934)', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await newNote(page, `Tagged ${RUN}`, `Seeds #fold${RUN}`);
  const pane = page.getByTestId('tag-pane');
  // Exactly: on hover its title row also has Move Tags and Hide Tags (T53 item 8).
  const toggle = pane.getByRole('button', { name: 'Tags', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(pane.getByRole('button', { name: new RegExp(`^#fold${RUN},`) })).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(pane.getByRole('button', { name: new RegExp(`^#fold${RUN},`) })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('penmoss.sidebar.tags'))).toBe('1');
  await page.reload();
  await expect(
    page.getByTestId('tag-pane').getByRole('button', { name: 'Tags', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('tag-pane').getByRole('button', { name: 'Tags', exact: true }).click();
  await expect(
    page.getByTestId('tag-pane').getByRole('button', { name: new RegExp(`^#fold${RUN},`) }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('Settings: the bar, the heading and the sections stay put; the content scrolls (A942)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto('/settings/shortcuts');
  const content = page.locator('.settings-content');
  await expect(content).toBeVisible();
  const fixed = ['.settings-bar', '.settings-page > .settings-title > h1', '.settings-nav'];
  const tops = () =>
    Promise.all(fixed.map(async (selector) => (await page.locator(selector).boundingBox())!.y));
  const before = await tops();
  await content.hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await tops()).toEqual(before);
  // The page itself never scrolls.
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
  // In a window too short for the sections, their list scrolls on its own.
  await page.setViewportSize({ width: 1280, height: 320 });
  const nav = page.locator('.settings-nav');
  expect(await nav.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
  expect(errors).toEqual([]);
});

test('Settings: the heading keeps the page gutter, in line with the sections (PEN-64)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/settings/shortcuts');
  const heading = page.locator('.settings-title > h1');
  await expect(heading).toBeVisible();
  await expect(page.locator('.settings-nav a').first()).toBeVisible();
  const left = async (selector: string) => (await page.locator(selector).first().boundingBox())!.x;
  // The heading and the sections' list start at the same gutter, well clear of the window's edge.
  const headingLeft = await left('.settings-title > h1');
  expect(headingLeft).toBeGreaterThan(20);
  expect(Math.abs(headingLeft - (await left('.settings-nav')))).toBeLessThanOrEqual(1);
  // Held on screen, so the proof's recording shows the heading in line.
  await page.waitForTimeout(2_000);
  await expect(heading).toBeInViewport();
  expect(errors).toEqual([]);
});
