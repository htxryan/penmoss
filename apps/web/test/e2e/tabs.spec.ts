import { expect, test, type Locator, type Page } from './fixtures';
import { menuLayout, noteAction } from './note-menu';

// PEN-140 (web): note tabs in the main window. Notes open in the tab on screen, or in a new one
// behind (⌘-click, a middle click, ⌘↩ in Search) or in front (⇧⌘-click); ⌃Tab, ⇧⌃Tab and ⌘2
// switch; × and Close Tab close, Reopen Closed Tab brings one back where it was; tabs pin and
// drag into order; each keeps its own Back, scroll position and note panel; a trashed note's
// tab closes with Restore; and a reload brings every tab back (AC1–AC10, AC12).

const RUN = `${Date.now().toString(36)}${100 + Math.floor(Math.random() * 900)}`;
const ALPHA = `Alpha ${RUN}`;
const BETA = `Beta ${RUN}`;
const GAMMA = `Gamma ${RUN}`;
/** A note long enough to scroll. */
const LONG = `Long ${RUN}`;
const longText = Array.from(
  { length: 120 },
  (_, n) => `Line ${n + 1} of a note long enough to scroll.`,
).join('\n\n');
/** Ten more notes, for a strip of tabs each showing a note of its own (A1574: none twice). */
const EXTRAS = Array.from({ length: 10 }, (_, n) => `Extra ${n + 1} ${RUN}`);

test.use({
  seed: {
    name: 'Notes',
    notes: [
      { title: ALPHA, markdown: 'The first note.' },
      { title: BETA, markdown: 'The second note.' },
      { title: GAMMA, markdown: 'The third note.' },
      { title: LONG, markdown: longText },
      ...EXTRAS.map((title) => ({ title, markdown: 'One more note.' })),
    ],
  },
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const strip = (page: Page) => page.getByRole('tablist', { name: 'Open Tabs' });
const tabs = (page: Page) => strip(page).getByRole('tab');
const tab = (page: Page, title: string) =>
  strip(page).getByRole('tab', { name: new RegExp(`^${title}`) });
const tree = (page: Page) => page.getByTestId('note-list');
const row = (page: Page, title: string) =>
  tree(page).getByRole('link', { name: title, exact: true });

/** The tabs' titles in strip order, the active one starred. */
async function titles(page: Page): Promise<string[]> {
  return tabs(page).evaluateAll((items) =>
    items.map(
      (item) =>
        `${item.getAttribute('aria-selected') === 'true' ? '*' : ''}${item.querySelector('.tab-title bdi')?.textContent ?? ''}`,
    ),
  );
}

async function shows(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}

/** Opens a note in the tab on screen, from the sidebar's tree. */
async function open(page: Page, title: string): Promise<void> {
  await row(page, title).click();
  await shows(page, title);
}

/** Runs a command from the palette. */
async function palette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  const dialog = page.getByRole('dialog', { name: 'Command Palette' });
  await dialog.getByRole('combobox').fill(title);
  await expect(dialog.getByRole('option').first()).toContainText(title);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
}

async function rightClick(locator: Locator, item: string): Promise<void> {
  await locator.click({ button: 'right' });
  await locator.page().getByTestId(item).click();
}

test('notes open in the tab on screen or in new tabs, and the keys switch between them', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(row(page, ALPHA)).toBeVisible({ timeout: 40_000 });

  // One tab, active, above the note; a plain click shows the note in it (AC1).
  await open(page, ALPHA);
  await expect(strip(page)).toBeVisible();
  expect(await titles(page)).toEqual([`*${ALPHA}`]);
  await expect(tab(page, ALPHA)).toHaveAttribute('aria-selected', 'true');
  // The sidebar highlights the active tab's note.
  await expect(row(page, ALPHA)).toHaveAttribute('aria-current', 'page');
  await open(page, BETA);
  expect(await titles(page)).toEqual([`*${BETA}`]);

  // A middle click in the tree opens a tab behind this one; the note on screen stays (AC2).
  await row(page, GAMMA).click({ button: 'middle' });
  await expect(tabs(page)).toHaveCount(2);
  expect(await titles(page)).toEqual([`*${BETA}`, GAMMA]);
  await shows(page, BETA);

  // ⌘↩ in Search: another tab behind, after the one opened from this tab.
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'Search', exact: true })
    .click();
  const search = page.getByTestId('search');
  await search.getByRole('combobox', { name: 'Search notes' }).fill(LONG);
  const hits = search.getByRole('listbox', { name: 'Search results' }).getByRole('option');
  await expect(hits.first()).toContainText(LONG, { timeout: 20_000 });
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(search).toBeHidden();
  expect(await titles(page)).toEqual([`*${BETA}`, GAMMA, LONG]);
  await shows(page, BETA);

  // Open in New Tab from a tree row's menu, then ⇧⌘-click in the tree. The menu
  // leads with its open group, Open in New Tab and its ⌘-Click (a tab there too, A1570) above
  // Open in New Window and its ⌥-Click (mockup ac2), then a separator, New Note Here and New
  // Folder Here, the copy and pin, and the edits (A1571).
  await row(page, ALPHA).click({ button: 'right' });
  const rowMenu = page.getByRole('menu', { name: `“${ALPHA}”` });
  const openTab = rowMenu.getByTestId('note-open-tab');
  const openWindow = rowMenu.getByTestId('note-open-window');
  await expect(openTab).toHaveAccessibleName('Open in New Tab');
  await expect(openTab.getByTestId('menu-click-hint')).toHaveText(/^(⌘|Ctrl)-Click$/);
  await expect(openWindow.getByTestId('menu-click-hint')).toHaveText(/^(⌥|Alt)-Click$/);
  await expect(openWindow).toHaveAccessibleName('Open in New Window');
  expect((await menuLayout(rowMenu)).slice(0, 12)).toEqual([
    'note-open-tab',
    'note-open-window',
    '—',
    'note-new-note',
    'note-new-folder',
    '—',
    'note-menu-copy-agent-reference',
    'note-menu-quick-access',
    '—',
    'note-menu-rename',
    'note-menu-duplicate',
    'Move to Folder…',
  ]);
  await page.waitForTimeout(2_000);
  await openTab.click();
  expect(await titles(page)).toEqual([`*${BETA}`, GAMMA, LONG, ALPHA]);
  // Gamma is open in a tab already: ⇧⌘-click in the sidebar goes to that tab (A1574).
  await row(page, GAMMA).click({ modifiers: ['ControlOrMeta', 'Shift'] });
  expect(await titles(page)).toEqual([BETA, `*${GAMMA}`, LONG, ALPHA]);
  // Search's ⇧⌘↩ opens it again, in front: Search opens as asked.
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'Search', exact: true })
    .click();
  await search.getByRole('combobox', { name: 'Search notes' }).fill(GAMMA);
  await expect(hits.first()).toContainText(GAMMA, { timeout: 20_000 });
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(search).toBeHidden();
  expect(await titles(page)).toEqual([BETA, GAMMA, `*${GAMMA}`, LONG, ALPHA]);
  await page.keyboard.press('Control+Shift+Tab');
  expect(await titles(page)).toEqual([BETA, `*${GAMMA}`, GAMMA, LONG, ALPHA]);
  await shows(page, GAMMA);

  // The keys: ⌃Tab and ⇧⌃Tab, wrapping round, and ⌘2 (AC3).
  await page.keyboard.press('Control+Tab');
  expect(await titles(page)).toEqual([BETA, GAMMA, `*${GAMMA}`, LONG, ALPHA]);
  await page.keyboard.press('Control+Shift+Tab');
  await page.keyboard.press('Control+Shift+Tab');
  expect(await titles(page)).toEqual([`*${BETA}`, GAMMA, GAMMA, LONG, ALPHA]);
  await page.keyboard.press('Control+Shift+Tab');
  expect(await titles(page)).toEqual([BETA, GAMMA, GAMMA, LONG, `*${ALPHA}`]);
  await shows(page, ALPHA);
  await page.keyboard.press('ControlOrMeta+Digit4');
  expect(await titles(page)).toEqual([BETA, GAMMA, GAMMA, `*${LONG}`, ALPHA]);
  await shows(page, LONG);

  // × closes a tab, the one to its right takes over; Reopen Closed Tab puts it back (AC3).
  await tab(page, LONG).getByTestId('tab-close').click();
  expect(await titles(page)).toEqual([BETA, GAMMA, GAMMA, `*${ALPHA}`]);
  await palette(page, 'Reopen Closed Tab');
  expect(await titles(page)).toEqual([BETA, GAMMA, GAMMA, `*${LONG}`, ALPHA]);
  await palette(page, 'Close Tab');
  expect(await titles(page)).toEqual([BETA, GAMMA, GAMMA, `*${ALPHA}`]);
  // Two closed, two reopened in a row: each back where it was, the last one active.
  await palette(page, 'Close Tab');
  expect(await titles(page)).toEqual([BETA, GAMMA, `*${GAMMA}`]);
  await palette(page, 'Close Tab');
  expect(await titles(page)).toEqual([BETA, `*${GAMMA}`]);
  await palette(page, 'Reopen Closed Tab');
  expect(await titles(page)).toEqual([BETA, GAMMA, `*${GAMMA}`]);
  await palette(page, 'Reopen Closed Tab');
  expect(await titles(page)).toEqual([BETA, GAMMA, GAMMA, `*${ALPHA}`]);
  await shows(page, ALPHA);

  // Today's Note (⌘D) never takes the page on screen: a new tab, then that tab again (AC11).
  await page.keyboard.press('ControlOrMeta+KeyD');
  await expect(tabs(page)).toHaveCount(5);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  const today = (await page.getByTestId('note-title').inputValue()) || 'Untitled';
  expect(await titles(page)).toEqual([BETA, GAMMA, GAMMA, ALPHA, `*${today}`]);
  await page.keyboard.press('ControlOrMeta+Digit1');
  await shows(page, BETA);
  await page.keyboard.press('ControlOrMeta+KeyD');
  expect(await titles(page)).toEqual([BETA, GAMMA, GAMMA, ALPHA, `*${today}`]);
  await palette(page, 'Close Tab');
  expect(await titles(page)).toEqual([BETA, GAMMA, GAMMA, `*${ALPHA}`]);

  // New Tab: Home, with the cursor in Search.
  await page.getByTestId('tab-new').click();
  expect(await titles(page)).toEqual([BETA, GAMMA, GAMMA, ALPHA, '*Home']);
  await expect(page).toHaveURL(/\/$/);
  await expect(search.getByRole('combobox', { name: 'Search notes' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  await expect(page.getByTestId('empty-state')).toBeVisible();
  // Closing every other tab leaves Home alone, which shows no tab, only + (AC4, A1576).
  await palette(page, 'Close Other Tabs');
  await expect(tabs(page)).toHaveCount(0);
  await expect(page.getByTestId('tab-new')).toBeVisible();
  await expect(page.getByTestId('empty-state')).toBeVisible();

  // The proof ends on a strip of tabs.
  await open(page, ALPHA);
  await row(page, BETA).click({ button: 'middle' });
  await row(page, LONG).click({ button: 'middle' });
  await expect(tabs(page)).toHaveCount(3);
  await page.mouse.move(640, 500);
  await page.waitForTimeout(2_000);
  await expect(tab(page, ALPHA)).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('⌘-click on a sidebar note opens a tab behind the one on screen, which stays as it was (A1570)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(row(page, ALPHA)).toBeVisible({ timeout: 40_000 });
  const item = (title: string) => tree(page).getByRole('treeitem', { name: title, exact: true });

  // Beta in Recent Notes and Alpha in Quick Access, then Long on screen, scrolled down.
  await open(page, BETA);
  await rightClick(item(ALPHA), 'note-menu-quick-access');
  const pin = page
    .getByTestId('quick-access')
    .getByTestId('quick-access-note')
    .filter({ hasText: ALPHA });
  await expect(pin).toBeVisible();
  await open(page, LONG);
  expect(await titles(page)).toEqual([`*${LONG}`]);
  const scroller = page.getByTestId('note-scroll');
  await scroller.evaluate((element) => {
    element.scrollTop = 900;
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(800);
  const scrolled = await scroller.evaluate((element) => element.scrollTop);
  const address = page.url();
  await expect(item(LONG)).toHaveAttribute('aria-selected', 'true');

  /** Long's tab is still the one on screen, at the same place, its row the one selected. */
  async function unchanged(): Promise<void> {
    await shows(page, LONG);
    await expect(tab(page, LONG)).toHaveAttribute('aria-selected', 'true');
    expect(page.url()).toBe(address);
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scrolled);
    await expect(item(LONG)).toHaveAttribute('aria-selected', 'true');
    await expect(item(LONG).getByRole('link')).toHaveAttribute('aria-current', 'page');
  }

  // The tree: ⌘-click (Ctrl-click) opens Gamma behind and picks nothing.
  await row(page, GAMMA).click({ modifiers: ['ControlOrMeta'] });
  await expect(tabs(page)).toHaveCount(2);
  expect(await titles(page)).toEqual([`*${LONG}`, GAMMA]);
  await expect(item(GAMMA)).toHaveAttribute('aria-selected', 'false');
  await unchanged();

  // Quick Access and Recent Notes: the same, each after the tabs opened from this one.
  await pin.click({ modifiers: ['ControlOrMeta'] });
  await expect(tabs(page)).toHaveCount(3);
  await page
    .getByTestId('recent-note')
    .filter({ hasText: BETA })
    .first()
    .click({ modifiers: ['ControlOrMeta'] });
  await expect(tabs(page)).toHaveCount(4);
  expect(await titles(page)).toEqual([`*${LONG}`, GAMMA, ALPHA, BETA]);
  await unchanged();

  // Today in the sidebar's shortcuts: its note behind too.
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'Today', exact: true })
    .click({ modifiers: ['ControlOrMeta'] });
  await expect(tabs(page)).toHaveCount(5);
  await unchanged();

  // In the tree, once several rows are picked (Shift-click), ⌘-click adds a note or takes one
  // out, and opens no tab (A570, A1570).
  await item(GAMMA).click({ modifiers: ['Shift'] });
  await expect(item(GAMMA)).toHaveAttribute('aria-selected', 'true');
  await expect(item(LONG)).toHaveAttribute('aria-selected', 'true');
  await item(ALPHA).click({ modifiers: ['ControlOrMeta'] });
  await expect(item(ALPHA)).toHaveAttribute('aria-selected', 'true');
  await item(GAMMA).click({ modifiers: ['ControlOrMeta'] });
  await expect(item(GAMMA)).toHaveAttribute('aria-selected', 'false');
  await expect(item(ALPHA)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs(page)).toHaveCount(5);
  await unchanged();
  expect(errors).toEqual([]);
});

test('with no note open there is no tab, only +, and a dad joke over two lines of hints (A1576)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(row(page, ALPHA)).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('tab-strip')).toBeVisible();
  await expect(tabs(page)).toHaveCount(0);
  await expect(page.getByTestId('tab-new')).toBeVisible();
  const empty = page.getByTestId('empty-state');
  const joke = empty.getByRole('heading', { level: 2 });
  await expect(joke).toHaveText(/\S/);
  await expect(empty).not.toContainText('No note open');
  const hints = empty.getByTestId('empty-hint');
  await expect(hints).toHaveText([
    /^Open a note or create one with New Note \((⌥⌘N|Ctrl\+Alt\+N|.+)\)\.$/,
    /^Or open the Command Palette \(.+\)\.$/,
  ]);
  const first = await joke.textContent();
  // ⌘1 does nothing here.
  await page.keyboard.press('ControlOrMeta+Digit1');
  await expect(tabs(page)).toHaveCount(0);

  // A note opened is the first tab; closing it brings back no tab, and another joke.
  await open(page, ALPHA);
  expect(await titles(page)).toEqual([`*${ALPHA}`]);
  await tab(page, ALPHA).getByTestId('tab-close').click();
  await expect(tabs(page)).toHaveCount(0);
  await expect(joke).toHaveText(/\S/);
  expect(await joke.textContent()).not.toBe(first);

  // A tab opened from here, ⌘-click or a middle click, takes the hidden Home's place: just it.
  await row(page, BETA).click({ modifiers: ['ControlOrMeta'] });
  expect(await titles(page)).toEqual([`*${BETA}`]);
  await shows(page, BETA);
  await tab(page, BETA).getByTestId('tab-close').click();
  await expect(tabs(page)).toHaveCount(0);
  await row(page, GAMMA).click({ button: 'middle' });
  expect(await titles(page)).toEqual([`*${GAMMA}`]);
  await shows(page, GAMMA);
  expect(errors).toEqual([]);
});

test('a sidebar note already open in a tab is gone to there, never opened twice (A1574)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(row(page, ALPHA)).toBeVisible({ timeout: 40_000 });
  await open(page, ALPHA);
  await row(page, BETA).click({ button: 'middle' });
  expect(await titles(page)).toEqual([`*${ALPHA}`, BETA]);

  // A click on Beta in the tree, open behind: its tab comes in front, Alpha's keeps Alpha.
  await row(page, BETA).click();
  await shows(page, BETA);
  expect(await titles(page)).toEqual([ALPHA, `*${BETA}`]);

  // ⌘-click on Alpha, open already: no second tab, Beta stays on screen, Alpha's tab blinks.
  await row(page, ALPHA).click({ modifiers: ['ControlOrMeta'] });
  expect(await tab(page, ALPHA).evaluate((element) => element.getAnimations().length)).toBe(1);
  await page.waitForTimeout(300);
  expect(await titles(page)).toEqual([ALPHA, `*${BETA}`]);
  await shows(page, BETA);
  // ⇧⌘-click on it: its tab.
  await row(page, ALPHA).click({ modifiers: ['ControlOrMeta', 'Shift'] });
  await shows(page, ALPHA);
  expect(await titles(page)).toEqual([`*${ALPHA}`, BETA]);

  // Recent Notes: the same.
  await page.getByTestId('recent-note').filter({ hasText: BETA }).first().click();
  await shows(page, BETA);
  expect(await titles(page)).toEqual([ALPHA, `*${BETA}`]);

  // A note in no tab opens in the tab on screen, as before; Back steps that tab, never jumps.
  await open(page, GAMMA);
  expect(await titles(page)).toEqual([ALPHA, `*${GAMMA}`]);
  await page.goBack();
  await shows(page, BETA);
  expect(await titles(page)).toEqual([ALPHA, `*${BETA}`]);
  expect(errors).toEqual([]);
});

test('each tab keeps its own Back, scroll and panel, and a reload brings the tabs back', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(row(page, ALPHA)).toBeVisible({ timeout: 40_000 });

  // Tab 1: Alpha, then the long note, scrolled down.
  await open(page, ALPHA);
  await open(page, LONG);
  const scroller = page.getByTestId('note-scroll');
  await scroller.evaluate((element) => {
    element.scrollTop = 900;
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(800);
  // Tab 2: Beta, with Version History open: its row's menu opens the tab, then ⌘2 shows it.
  await rightClick(row(page, BETA), 'note-open-tab');
  await page.keyboard.press('ControlOrMeta+Digit2');
  await shows(page, BETA);
  await page.getByTestId('note-tab-history').click();
  await expect(page.getByTestId('note-tab-history')).toHaveAttribute('aria-selected', 'true');

  // Back in tab 1: its own page, scroll and closed panel (AC6).
  await page.keyboard.press('ControlOrMeta+Digit1');
  await shows(page, LONG);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(800);
  await expect(page.getByTestId('note-tab-history')).toHaveAttribute('aria-selected', 'false');
  // Back steps this tab's history only, and its tooltip says where to (AC6).
  await page.mouse.move(640, 500);
  await expect(async () => {
    await page.getByTestId('app-back').hover();
    await expect(page.getByTestId('tooltip')).toHaveText(
      new RegExp(`^Back to ${ALPHA} \\(this tab\\) \\(.+\\)$`),
      { timeout: 3_000 },
    );
  }).toPass();
  await page.mouse.move(640, 500);
  await page.getByTestId('app-back').click();
  await shows(page, ALPHA);
  await expect(page.getByTestId('app-forward')).toBeEnabled();
  await page.getByTestId('app-forward').click();
  await shows(page, LONG);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(800);
  // Tab 2 has no history of its own to go back to.
  await page.keyboard.press('ControlOrMeta+Digit2');
  await shows(page, BETA);
  await expect(page.getByTestId('note-tab-history')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('app-back')).toBeDisabled();

  // The tab's menu shows Close Tab's keys (ac5).
  await tab(page, BETA).click({ button: 'right' });
  await expect(page.getByTestId('tab-menu-close').locator('.menu-keys')).toHaveText(/W/);
  await page.keyboard.press('Escape');
  // Pin tab 2: it moves to the start, with a pin and no ×; a plain click opens a new tab (AC5).
  await rightClick(tab(page, BETA), 'tab-menu-pin');
  expect(await titles(page)).toEqual([`*${BETA}`, LONG]);
  await expect(tab(page, BETA).getByTestId('tab-pinned')).toBeVisible();
  await expect(tab(page, BETA).getByTestId('tab-close')).toHaveCount(0);
  // The pin leads the tab, before its badge.
  const pinBox = (await tab(page, BETA).getByTestId('tab-pinned').boundingBox())!;
  const markBox = (await tab(page, BETA).locator('.tab-mark').boundingBox())!;
  expect(pinBox.x + pinBox.width).toBeLessThanOrEqual(markBox.x);
  await open(page, GAMMA);
  expect(await titles(page)).toEqual([BETA, `*${GAMMA}`, LONG]);
  await page.keyboard.press('ControlOrMeta+Digit1');
  expect(await titles(page)).toEqual([`*${BETA}`, GAMMA, LONG]);

  // Drag Long before Gamma (within the unpinned tabs).
  await tab(page, LONG).dragTo(tab(page, GAMMA), { targetPosition: { x: 4, y: 10 } });
  expect(await titles(page)).toEqual([`*${BETA}`, LONG, GAMMA]);
  // ⌥→ on a focused tab moves it too.
  await tab(page, LONG).focus();
  await page.keyboard.press('Alt+ArrowRight');
  expect(await titles(page)).toEqual([`*${BETA}`, GAMMA, LONG]);

  // A reload: the same tabs, order, pin and active tab, and each tab's page, scroll and
  // panel (AC7).
  await page.keyboard.press('ControlOrMeta+Digit3');
  await shows(page, LONG);
  await page.waitForTimeout(500);
  await page.reload();
  await expect(tabs(page)).toHaveCount(3, { timeout: 40_000 });
  expect(await titles(page)).toEqual([BETA, GAMMA, `*${LONG}`]);
  await expect(tab(page, BETA)).toHaveAttribute('data-pinned', '');
  await shows(page, LONG);
  await expect
    .poll(() => page.getByTestId('note-scroll').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(800);
  await page.getByTestId('app-back').click();
  await shows(page, ALPHA);
  await tab(page, BETA).click();
  await shows(page, BETA);
  await expect(page.getByTestId('note-tab-history')).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(2_000);
  await expect(tab(page, BETA)).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('a trashed note’s tab closes and comes back with Undo; renames show at once (AC9)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(row(page, ALPHA)).toBeVisible({ timeout: 40_000 });
  await open(page, ALPHA);
  await row(page, BETA).click({ button: 'middle' });
  await row(page, GAMMA).click({ button: 'middle' });
  expect(await titles(page)).toEqual([`*${ALPHA}`, BETA, GAMMA]);

  // A rename shows on its tab at once, a background tab's too.
  const renamed = `Alpha renamed ${RUN}`;
  await page.getByTestId('note-title').fill(renamed);
  await expect(tab(page, renamed)).toBeVisible();

  // Move to Trash closes its tab; the tab to its right takes over.
  await page.keyboard.press('ControlOrMeta+Digit2');
  await shows(page, BETA);
  await noteAction(page, 'delete-note');
  expect(await titles(page)).toEqual([renamed, `*${GAMMA}`]);
  // Undo puts the note and its tab back where they were.
  await page.getByTestId('trashed-undo').click();
  await expect(tabs(page)).toHaveCount(3);
  expect(await titles(page)).toEqual([renamed, `*${BETA}`, GAMMA]);
  await shows(page, BETA);
  await page.waitForTimeout(2_000);
  expect(errors).toEqual([]);
});

test('many tabs scroll sideways, and All Tabs lists them (AC12)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(row(page, ALPHA)).toBeVisible({ timeout: 40_000 });
  await open(page, ALPHA);
  for (const title of [BETA, GAMMA, LONG, ...EXTRAS]) {
    await row(page, title).click({ button: 'middle' });
  }
  await expect(tabs(page)).toHaveCount(14);
  // Alpha pinned: it stays at the start as the rest scroll.
  await rightClick(tab(page, ALPHA), 'tab-menu-pin');
  await expect(tab(page, ALPHA).getByTestId('tab-pinned')).toBeVisible();
  // Each at least 120 px: the strip scrolls, and All Tabs shows with the count.
  const widths = await tabs(page).evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().width),
  );
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(119);
  const all = page.getByTestId('tab-all');
  await expect(all).toBeVisible();
  await expect(all).toHaveAccessibleName('All Tabs, 14');
  await all.click();
  const list = page.getByTestId('all-tabs');
  await expect(list.getByTestId('all-tabs-item')).toHaveCount(14);
  // The pinned tab first, with its pin and a rule under the pinned group (ac12).
  const items = list.getByTestId('all-tabs-item');
  await expect(items.first()).toContainText(ALPHA);
  await expect(items.first().getByTestId('all-tabs-pinned')).toBeVisible();
  await expect(items.first()).toHaveAttribute('data-group-end', '');
  await expect(items.first()).not.toHaveCSS('border-bottom-width', '0px');
  await expect(items.nth(1).getByTestId('all-tabs-pinned')).toHaveCount(0);
  await expect(list.getByTestId('all-tabs-pinned')).toHaveCount(1);
  await list.getByRole('combobox', { name: 'Filter Tabs' }).fill(LONG);
  await expect(list.getByTestId('all-tabs-item').first()).toContainText(LONG);
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  await shows(page, LONG);
  // The active tab is scrolled into view.
  const active = strip(page).getByRole('tab', { selected: true });
  await expect(active).toBeInViewport();
  await page.waitForTimeout(2_000);
  expect(errors).toEqual([]);
});

/** A CSS colour as sRGB 0–255 and alpha 0–1, through a canvas, so oklab and color-mix resolve. */
async function rgba(page: Page, css: string): Promise<[number, number, number, number]> {
  return page.evaluate((colour) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!, a! / 255] as [number, number, number, number];
  }, css);
}

/** WCAG contrast between two opaque sRGB colours. */
function contrast(a: readonly number[], b: readonly number[]): number {
  const luminance = (rgb: readonly number[]) => {
    const [r, g, bl] = rgb.slice(0, 3).map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

for (const scheme of ['light', 'dark'] as const) {
  test(`tabs fill the strip from its top edge, and inactive tabs show their edges (A1573, ${scheme})`, async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(row(page, ALPHA)).toBeVisible({ timeout: 40_000 });
    await open(page, ALPHA);
    await row(page, BETA).click({ button: 'middle' });
    await row(page, GAMMA).click({ button: 'middle' });
    expect(await titles(page)).toEqual([`*${ALPHA}`, BETA, GAMMA]);
    await page.mouse.move(640, 600);

    // Every tab spans the row, from its top edge down to the rule (the active one over it).
    const bar = (await strip(page).boundingBox())!;
    for (const each of await tabs(page).all()) {
      const box = (await each.boundingBox())!;
      expect(box.y).toBe(bar.y);
      expect(box.height).toBeGreaterThanOrEqual(bar.height - 1);
    }

    // An inactive tab draws a divider on its right, in a colour that reads on the strip.
    const colours = await strip(page).evaluate((list) => {
      const bar = list.closest('.tab-strip')!;
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--pm-tab-divider)';
      list.append(probe);
      const divider = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { divider, bar: getComputedStyle(bar).backgroundColor };
    });
    const line = await rgba(page, colours.divider);
    const ground = await rgba(page, colours.bar);
    expect(line[3]).toBeGreaterThan(0.9);
    expect(contrast(line, ground)).toBeGreaterThanOrEqual(1.4);
    const image = (title: string) =>
      tab(page, title).evaluate((element) => getComputedStyle(element).backgroundImage);
    expect(await image(BETA)).toMatch(/gradient/);
    // None beside the active tab or the hovered one, which show their own edges.
    expect(await image(ALPHA)).toBe('none');
    await tab(page, GAMMA).hover();
    await expect.poll(() => image(BETA)).toBe('none');
    await page.mouse.move(640, 600);
    await expect.poll(() => image(BETA)).toMatch(/gradient/);
    // The active tab: the accent line on top and an edge either side.
    const active = await tab(page, ALPHA).evaluate(
      (element) => getComputedStyle(element).boxShadow,
    );
    expect(active.match(/inset/g)?.length).toBe(3);
    expect(errors).toEqual([]);
  });
}
