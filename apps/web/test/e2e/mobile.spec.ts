import { expect, test, type Locator, type Page } from './fixtures';

// T36: the phone layout. Every screen is reachable on a phone-sized screen without the desktop
// site: the app bar's menu opens the sidebar as a drawer (Settings, Trash, folders, journal,
// tags), the ⋮ sheet holds the note's actions, and nothing scrolls sideways. The local Worker
// keeps one workspace: names carry a per-run tag.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const appBar = (page: Page) => page.getByTestId('app-bar');
const drawer = (page: Page) => page.getByRole('complementary', { name: 'Notes' });

/** Neither the page nor the notes pane scrolls sideways. */
async function expectNoSideScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const main = document.querySelector('.note-main');
    return {
      page: root.scrollWidth - root.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  expect(overflow, where).toEqual({ page: 0, main: 0 });
}

async function expectTouchSize(target: Locator, label: string) {
  const box = await target.boundingBox();
  expect(box, label).not.toBeNull();
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(44);
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(44);
}

async function openDrawer(page: Page) {
  await appBar(page).getByRole('button', { name: 'Open Navigation' }).tap();
  await expect(drawer(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close Navigation' })).toBeFocused();
  // Slid all the way in: mid-slide, a control's box sits at a fraction of a pixel, and its width
  // reads a hair under its 44 px.
  await expect
    .poll(() => drawer(page).evaluate((element) => element.getBoundingClientRect().left))
    .toBe(0);
}

async function newNote(page: Page, title: string, text: string): Promise<string> {
  await page.getByRole('button', { name: 'New Note', exact: true }).tap();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

test('a phone reaches Settings → Git Notebooks, History and Trash from a note', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  // The phone layout: an app bar, and the sidebar out of sight until the menu opens it.
  await expect(appBar(page)).toBeVisible();
  await expect(drawer(page)).toBeHidden();

  const title = `Phone note ${RUN}`;
  await newNote(page, title, 'Written on a small screen.');
  await expect(appBar(page).getByRole('heading', { level: 1 })).toHaveText(title);
  // The bar shows where the note is, not the title the note shows below it (T39 pass 3, A907).
  // A note at the top level: its notebook's name (T52), as the sidebar's heading has it.
  // (Its name's row is the one with the notebook's actions, T53 item 4; Recent Notes and the
  // other sections have titles of their own, T53 item 8.)
  const notebook = (await page
    .locator('.sb-section-head:has(.tree-actions) .sb-section-name')
    .first()
    .textContent())!.trim();
  await expect(appBar(page).getByTestId('app-bar-path')).toHaveText(notebook);
  await expectNoSideScroll(page, 'note');

  // A phone's default is closed (A960), with no strip of tab icons at the note's edge: every tab
  // is in the ⋯ sheet (T53 item 9).
  await expect(page.locator('.note-columns')).toHaveAttribute('data-panel', 'closed');
  await expect(page.getByTestId('note-rail')).toBeHidden();
  // History, from the note's sheet.
  await appBar(page).getByRole('button', { name: 'Note Actions' }).tap();
  const sheet = page.getByRole('menu', { name: 'Note Actions' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('menuitemcheckbox', { name: 'Version History' }).tap();
  await expect(sheet).toBeHidden();
  // The History tab of the note's panel covers the note below the app bar on a phone (T53 item 9):
  // its name and Close, the strip of tab icons beside it; nothing goes below the note.
  const panel = page.getByRole('complementary', { name: 'History' });
  const history = panel.getByTestId('history-panel');
  await expect(history).toBeVisible();
  await expect(history.getByRole('heading', { name: 'Version History' })).toBeVisible();
  await expect(panel.locator('.note-side-head h2')).toHaveText('History');
  await expect(page.getByTestId('note-tab-history')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.note-columns')).toHaveAttribute('data-over', '');
  const rail = page.getByTestId('note-rail');
  await expect(rail).toBeVisible();
  const viewport = page.viewportSize()!;
  const bar = (await appBar(page).boundingBox())!;
  const box = (await panel.boundingBox())!;
  const strip = (await rail.boundingBox())!;
  // The panel and the strip share the screen's width, the strip at its right edge.
  expect(box.x).toBe(0);
  expect(Math.abs(box.x + box.width - strip.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(strip.x + strip.width - viewport.width)).toBeLessThanOrEqual(1);
  expect(box.y).toBeLessThanOrEqual(bar.y + bar.height + 1);
  expect(box.y + box.height).toBeGreaterThanOrEqual(viewport.height - 1);
  // The strip's icons sit below the app bar, each a touch target, and change the tab.
  const infoTab = page.getByTestId('note-tab-info');
  expect((await infoTab.boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
  await expectTouchSize(infoTab, 'Metadata tab');
  await infoTab.tap();
  await expect(page.getByRole('complementary', { name: 'Metadata' })).toBeVisible();
  await expect(infoTab).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('note-tab-history').tap();
  await expect(history).toBeVisible();
  await page.getByTestId('note-panel-close').tap();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.note-columns')).toHaveAttribute('data-panel', 'closed');
  // Closed, no strip: every tab is in the sheet.
  await expect(rail).toBeHidden();
  // The sheet has each tab, ticked while it shows, and no Note Panel modes any more.
  await appBar(page).getByRole('button', { name: 'Note Actions' }).tap();
  await expect(sheet.getByRole('menuitem', { name: /^Note Panel/ })).toHaveCount(0);
  await expect(sheet.getByRole('menuitemcheckbox', { name: 'Version History' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await sheet.getByRole('menuitemcheckbox', { name: 'View Metadata' }).tap();
  await expect(page.getByRole('complementary', { name: 'Metadata' })).toBeVisible();
  // The open tab's icon closes it, as on a wider screen.
  await infoTab.tap();
  await expect(page.locator('aside.note-side')).toHaveCount(0);
  await expect(rail).toBeHidden();

  // Settings → Git Notebooks (the notebooks on this Mac, T59), from the drawer.
  await openDrawer(page);
  await drawer(page).getByRole('link', { name: 'Settings', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/);
  const sections = page.getByRole('navigation', { name: 'Settings sections' });
  await sections.getByRole('link', { name: 'Git Notebooks', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/git-notebooks$/);
  const gitSettings = page.getByTestId('git-notebooks-settings');
  await expect(
    gitSettings.getByRole('heading', { name: 'Git Notebooks', exact: true }),
  ).toBeVisible();
  // The list, then the notebook's own page (A1098).
  await expect(gitSettings.getByTestId('git-notebook-row')).toHaveCount(1);
  await expectNoSideScroll(page, 'git notebooks');
  await gitSettings.getByTestId('git-notebook-row').tap();
  await expect(gitSettings.getByTestId('git-notebook')).toHaveCount(1);
  await expect(gitSettings.getByTestId('git-sync-now')).toBeVisible();
  await expectNoSideScroll(page, 'git notebook page');

  // Back to the note (the Mac app goes back to the note open before Settings, B13), then to
  // Trash through the note's sheet and the drawer.
  await page.getByRole('link', { name: 'Notes', exact: true }).tap();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
  // Opening a note closed the drawer.
  await expect(drawer(page)).toBeHidden();
  await appBar(page).getByRole('button', { name: 'Note Actions' }).tap();
  await page.getByRole('menuitem', { name: 'Move to Trash' }).tap();
  await expect(page).toHaveURL(/\/$/);
  // Back on the screen it was last opened on, the drawer stays closed.
  await expect(drawer(page)).toBeHidden();
  await openDrawer(page);
  await drawer(page).getByRole('link', { name: 'Trash', exact: true }).tap();
  // The notebook's own Trash.
  await expect(page).toHaveURL(/\/trash\?source=[0-9A-Z]{26}$/);
  await expect(drawer(page)).toBeHidden();
  await expect(page.getByTestId('trash').getByText(title, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Restore ${title}` })).toBeVisible();
  await expectNoSideScroll(page, 'trash');
  expect(errors).toEqual([]);
});

test('the drawer is a modal panel: Escape closes it and focus returns', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await openDrawer(page);
  // The rest of the page is inert while it is open.
  await expect(page.locator('main.note-main')).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toBeHidden();
  await expect(appBar(page).getByRole('button', { name: 'Open Navigation' })).toBeFocused();
  await expect(page.locator('main.note-main')).not.toHaveAttribute('inert', '');

  // The scrim closes it too.
  await openDrawer(page);
  await page.mouse.click(PHONE.width - 10, PHONE.height / 2);
  await expect(drawer(page)).toBeHidden();
  expect(errors).toEqual([]);
});

test('phone controls are at least 44 px and nothing scrolls sideways', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(appBar(page)).toBeVisible();
  for (const name of ['Open Navigation', 'Search Notes']) {
    await expectTouchSize(appBar(page).getByRole('button', { name, exact: true }), name);
  }
  await expectTouchSize(page.getByRole('button', { name: 'New Note', exact: true }), 'New Note');
  const id = await newNote(page, `Touch ${RUN}`, 'Big enough to tap.');
  const toolbar = page.getByRole('toolbar', { name: 'Formatting' });
  await expect(toolbar).toBeVisible();
  for (const name of ['Bold', 'Italic', 'Checklist', 'Undo']) {
    await expectTouchSize(toolbar.getByRole('button', { name }), `format ${name}`);
  }
  // The formatting bar acts on the note.
  await page.getByTestId('note-body').locator('.ProseMirror').press('ControlOrMeta+a');
  await toolbar.getByRole('button', { name: 'Bold' }).tap();
  await expect(page.getByTestId('note-body').locator('strong')).toHaveText('Big enough to tap.');

  await appBar(page).getByRole('button', { name: 'Note Actions' }).tap();
  const items = page.getByRole('menu', { name: 'Note Actions' }).locator('[role^="menuitem"]');
  expect(await items.count()).toBeGreaterThanOrEqual(8);
  for (const item of await items.all()) await expectTouchSize(item, (await item.textContent())!);
  await page.keyboard.press('Escape');

  await openDrawer(page);
  const actions = drawer(page).locator('.sb-actions');
  // One row of icon buttons, New Note first (T51, A932; T52), each still a 44 px target.
  for (const name of ['New Note', 'Search', 'Today', 'This Week', 'Commands']) {
    await expectTouchSize(actions.getByRole('button', { name, exact: true }), name);
  }
  await expectTouchSize(actions.getByRole('link', { name: 'Graph', exact: true }), 'Graph');
  // The icons keep one row (the ⋯ menu moved to Settings → Display, T62 item 11).
  const icons = await actions.locator('.sb-shortcut').all();
  const tops = await Promise.all(icons.map(async (icon) => (await icon.boundingBox())!.y));
  expect(new Set(tops.map(Math.round)).size).toBe(1);
  await expect(drawer(page).getByTestId('sidebar-more')).toHaveCount(0);
  for (const name of ['Settings', 'Trash']) {
    await expectTouchSize(drawer(page).getByRole('link', { name, exact: true }), name);
  }
  // The sort order is an icon button that opens a menu (T52), still a 44 px target (T36).
  const sort = drawer(page).getByRole('button', { name: /^Sort Order for / });
  await expectTouchSize(sort, 'sort order');
  expect((await sort.boundingBox())!.width).toBeLessThan(60);
  await expectNoSideScroll(page, 'drawer');
  await page.keyboard.press('Escape');

  // Settings → Keyboard shortcuts: one compact row per command, its icon buttons side by side.
  await page.goto('/settings/shortcuts');
  const row = page.locator('tr[data-command-row="app.palette"]');
  const change = row.getByRole('button', { name: 'Change the Shortcut for Command Palette' });
  const remove = row.getByRole('button', { name: 'Remove the Shortcut for Command Palette' });
  await expectTouchSize(change, 'Change');
  await expectTouchSize(remove, 'Remove');
  expect((await remove.boundingBox())!.y).toBeCloseTo((await change.boundingBox())!.y, 0);
  expect((await row.boundingBox())!.height).toBeLessThan(80);

  for (const width of [360, 430]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of [
      '/',
      `/notes/${id}`,
      '/settings',
      '/settings/shortcuts',
      '/settings/journal',
      '/settings/git-mirror',
      '/settings/devices',
      '/trash',
      '/graph',
    ]) {
      await page.goto(path);
      await expect(page.getByTestId('app-root')).toBeVisible();
      await page.waitForTimeout(300);
      await expectNoSideScroll(page, `${path} at ${width} px`);
    }
  }
  expect(errors).toEqual([]);
});
