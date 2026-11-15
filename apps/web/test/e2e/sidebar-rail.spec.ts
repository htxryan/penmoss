// The sidebar as an icon rail, its foot and its head.
import { expect, type Page, test } from './fixtures';
import { collectErrors, newNote, ULID } from './support/app';
import { storedSetting } from './stored';
import { SIDEBAR } from './keys';

const RUN = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// T41.
test('the sidebar: an icon rail, remembered; a tag filter moves nothing below the list', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const tag = `rail${RUN}`;
  await newNote(page, `Rail ${RUN}`, `A note with #${tag}`);
  const calendar = () =>
    page.locator('.sidebar .calendar').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { top: Math.round(box.top), height: Math.round(box.height) };
    });
  // The tags' section of the sidebar (T53 item 8, A983): its own box, which scrolls its list.
  const tagPane = () =>
    page
      .getByTestId('tag-pane')
      .evaluate((element) =>
        Math.round((element.closest('.sb-part') ?? element).getBoundingClientRect().top),
      );
  await expect(page.getByTestId('tag-pane').getByText(tag, { exact: true })).toBeVisible();
  // The sections in the synced order (T53 item 8), once it has arrived: measured before, a late
  // order would move them for another reason than the tag.
  const stored = await storedSetting(page, 'sidebar.sectionOrder');
  if (Array.isArray(stored)) {
    const known = ['quickAccess', 'recent', 'notebooks', 'calendar', 'tags'];
    const order = (stored as string[]).filter((id) => known.includes(id));
    await expect
      .poll(() =>
        page
          .locator('#app-sidebar .sb-part[data-section]')
          .evaluateAll((parts) => parts.map((part) => part.getAttribute('data-section'))),
      )
      .toEqual([...order, ...known.filter((id) => !order.includes(id))]);
  }
  const before = { calendar: await calendar(), tags: await tagPane() };
  // A tag opens Search on its notes (finding 9 of the #192 review): the sidebar stays put.
  await page.getByTestId('tag-pane').getByText(tag, { exact: true }).click();
  await expect(page.getByTestId('search').locator('.search-hit').first()).toBeVisible();
  expect({ calendar: await calendar(), tags: await tagPane() }).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search')).toBeHidden();
  expect({ calendar: await calendar(), tags: await tagPane() }).toEqual(before);

  // Collapsed: Search, Today, This Week, Graph and Commands (and Back and Forward, A943). Collapsed from the
  // tree, focus moves to the toggle rather than into hidden rows.
  await page
    .getByRole('tree', { name: 'Folders and notes' })
    .locator('[aria-current="page"]')
    .first()
    .focus();
  await page.keyboard.press(SIDEBAR);
  await expect(page.getByTestId('toggle-sidebar')).toBeFocused();
  const sidebar = page.getByRole('complementary', { name: 'Notes' });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
  for (const name of [/^Search/, /^Today/, /^This Week/, /^Graph/, /^Commands/]) {
    await expect(
      sidebar.getByRole('button', { name }).or(sidebar.getByRole('link', { name })),
    ).toBeVisible();
  }
  await expect(sidebar.getByRole('tree', { name: 'Folders and notes' })).toBeHidden();
  await expect(sidebar.locator('.calendar')).toBeHidden();
  await expect(sidebar.getByTestId('tag-pane')).toBeHidden();
  expect(
    await sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)),
  ).toBeLessThan(60);
  // The rail's buttons still work.
  await sidebar.getByRole('button', { name: /^Commands/ }).click();
  await expect(page.getByRole('dialog', { name: /Command palette/i })).toBeVisible();
  await page.keyboard.press('Escape');

  // Remembered on this device.
  await page.reload();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).not.toHaveAttribute('data-sidebar', 'collapsed');
  await expect(sidebar.getByRole('tree', { name: 'Folders and notes' })).toBeVisible();
  // The open note's row, revealed while the tree was hidden, comes into view when it shows.
  await expect(sidebar.locator('[aria-current="page"]').first()).toBeInViewport();
  expect(errors).toEqual([]);
});

const radius = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).borderRadius);
// T53, items 1, 3.
test('the rail starts at the top, square; Today and This Week show when their note is open', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await newNote(page, `Rail ${RUN}`, 'Not a journal note.');
  const today = page.locator('.sb-shortcut[data-command="journal.today"]');
  const week = page.locator('.sb-shortcut[data-command="journal.thisWeek"]');
  await expect(today).not.toHaveAttribute('aria-current', 'page');
  await expect(week).not.toHaveAttribute('aria-current', 'page');

  await today.click();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(today).toHaveAttribute('aria-current', 'page');
  await expect(week).not.toHaveAttribute('aria-current', 'page');
  await week.click();
  await expect(week).toHaveAttribute('aria-current', 'page');
  await expect(today).not.toHaveAttribute('aria-current', 'page');

  // The rail: its first button at the very top, every highlight square. Beside a note, Back and
  // Forward start the note's title bar, so the toggle is first (PEN-135 item 6).
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
  const sidebar = (await page.locator('#app-sidebar').boundingBox())!;
  const first = (await page.getByTestId('toggle-sidebar').boundingBox())!;
  expect(first.y - sidebar.y).toBeLessThan(1);
  await expect(page.locator('.note-top').getByTestId('app-back')).toBeVisible();
  await expect(week).toHaveAttribute('aria-current', 'page');
  for (const selector of [
    '.history-pair',
    '.history-pair .history-half',
    '.sb-shortcut.new-note',
    'button[data-command="journal.thisWeek"]',
    '.sb-collapse',
  ]) {
    expect(await radius(page, selector), selector).toBe('0px');
  }
  await page.getByTestId('toggle-sidebar').click();

  // Square everywhere else too: buttons, fields, menus.
  await page.getByTestId('sidebar-settings').click();
  expect(await radius(page, '.btn, button.primary, .settings-nav a')).toBe('0px');
  expect(await radius(page, 'input:is([type="text"], [type="search"], :not([type])), select')).toBe(
    '0px',
  );
  expect(errors).toEqual([]);
});

const SHOTS = process.env['PENMOSS_EVIDENCE'];

const LONG = Array.from({ length: 80 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n\n');

const tree = (page: Page) =>
  page
    .getByTestId('source-section')
    .and(page.getByRole('region', { name: 'Quanta', exact: true }))
    .getByRole('tree', { name: 'Folders and notes' });

const box = async (page: Page, selector: string) =>
  (await page.locator(selector).first().boundingBox())!;
test.describe('in Quanta, with a folder and a long note', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Miscellaneous'],
      notes: [{ title: 'Josh Onboarding' }, { title: 'Long', markdown: `${LONG}\n` }],
    },
  });

  // T65, item 1.
  test('Settings and Send Feedback sit flush in the sidebar’s bottom row, square, the row’s height', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(tree(page)).toBeVisible({ timeout: 30_000 });
    const foot = await box(page, '.sb-foot');
    const sidebar = await box(page, '.sidebar');
    const settings = await box(page, '[data-testid="sidebar-settings"]');
    const feedback = await box(page, '[data-testid="sidebar-feedback"]');
    // Square, as tall as the row under its top border, no gap between them or at the row's ends.
    for (const button of [settings, feedback]) {
      expect(button.width).toBeCloseTo(button.height, 0);
      expect(button.y).toBeCloseTo(foot.y + 1, 0);
      expect(button.y + button.height).toBeCloseTo(foot.y + foot.height, 0);
    }
    expect(settings.x).toBeCloseTo(sidebar.x, 0);
    expect(feedback.x).toBeCloseTo(settings.x + settings.width, 0);
    await page.getByTestId('sidebar-feedback').hover();
    if (SHOTS) {
      await page.screenshot({
        path: `${SHOTS}/sidebar-foot.png`,
        clip: { x: sidebar.x, y: foot.y - 40, width: sidebar.width, height: foot.height + 40 },
      });
    }
    expect(errors).toEqual([]);
  });
});

/** The traffic lights' room in a compact window (`--pm-titlebar-inset`, A722). */
const INSET = 88;

async function openNote(page: Page, title: string): Promise<void> {
  await tree(page).getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}

const compact = (page: Page) =>
  expect(page.locator('html')).toHaveAttribute('data-titlebar', 'compact');

async function collapse(page: Page): Promise<void> {
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
}

async function expand(page: Page): Promise<void> {
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).not.toHaveAttribute('data-sidebar', 'collapsed');
}
test.describe('in the Mac window, in Quanta with two notes', () => {
  test.use({
    macWindow: true,
    seed: {
      name: 'Quanta',
      notes: [
        { title: 'Alpha', markdown: 'The first note.\n' },
        { title: 'Bravo', markdown: 'The second note.\n' },
      ],
    },
  });

  // PEN-135, item 4.
  test('the rail keeps Settings and Send Feedback at its foot', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(tree(page)).toBeVisible({ timeout: 30_000 });
    await collapse(page);
    const rail = await box(page, '.sidebar');
    const settings = page.getByTestId('sidebar-settings');
    const feedback = page.getByTestId('sidebar-feedback');
    await expect(settings).toBeVisible();
    await expect(feedback).toBeVisible();
    const s = (await settings.boundingBox())!;
    const f = (await feedback.boundingBox())!;
    // A column at the rail's foot, each the rail's width, Feedback above Settings, which is last
    // (Ryan's review of #192, finding 18).
    expect(s.y + s.height).toBeCloseTo(rail.y + rail.height, 0);
    expect(f.y + f.height).toBeCloseTo(s.y, 0);
    // Tab goes in the order shown.
    await feedback.focus();
    await page.keyboard.press('Tab');
    await expect(settings).toBeFocused();
    for (const button of [s, f]) {
      expect(button.x).toBeCloseTo(rail.x, 0);
      expect(button.width).toBeGreaterThanOrEqual(rail.width - 2);
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-4-rail-foot.png` });
    // Each still works from there.
    await settings.click();
    await expect(page).toHaveURL(/\/settings/);
    await page.goBack();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
    await feedback.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expand(page);
    expect(errors).toEqual([]);
  });
  // PEN-135, item 8.
  test('the sidebar’s head never clips its buttons, however narrow the sidebar', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(tree(page)).toBeVisible({ timeout: 30_000 });
    await compact(page);
    await openNote(page, 'Alpha');
    const edge = page.getByTestId('sidebar-resizer');
    await edge.focus();
    // The narrowest (Home), then a rem at a time up to 18rem.
    await page.keyboard.press('Home');
    await expect(edge).toHaveAttribute('aria-valuenow', '14.5');
    if (SHOTS)
      await page.locator('.sidebar').screenshot({ path: `${SHOTS}/pen-135-8-narrowest.png` });
    for (let step = 0; step <= 4; step++) {
      const sidebar = await box(page, '.sidebar');
      const right = sidebar.x + sidebar.width;
      const ids = ['app-back', 'app-forward', 'keep-on-top', 'toggle-sidebar'];
      const boxes = await Promise.all(ids.map((id) => box(page, `.sb-head [data-testid="${id}"]`)));
      // Each whole, inside the sidebar, after the lights, in order.
      for (const [index, each] of boxes.entries()) {
        expect(each.x, ids[index]).toBeGreaterThanOrEqual(INSET);
        expect(each.x + each.width, ids[index]).toBeLessThanOrEqual(right + 0.5);
        if (index > 0) expect(each.x, ids[index]).toBeGreaterThanOrEqual(boxes[index - 1]!.x);
      }
      // The toggle ends the head at the sidebar's edge; the pin is right before it.
      const [, forward, pin, toggle] = boxes as [
        typeof sidebar,
        typeof sidebar,
        typeof sidebar,
        typeof sidebar,
      ];
      expect(toggle.x + toggle.width).toBeCloseTo(right - 1, 0);
      expect(pin.x + pin.width).toBeCloseTo(toggle.x, 0);
      // The logo shows only with room for it; at the narrowest the pin follows Forward.
      if (step === 0) expect(pin.x - (forward.x + forward.width)).toBeLessThan(8);
      await page.keyboard.press('ArrowRight');
    }
    if (SHOTS) await page.locator('.sidebar').screenshot({ path: `${SHOTS}/pen-135-8-wider.png` });
    // Without the compact title bar too: the name goes before any button.
    await page.evaluate(() => delete document.documentElement.dataset['titlebar']);
    await page.keyboard.press('Home');
    const sidebar = await box(page, '.sidebar');
    const toggle = await box(page, '.sb-head [data-testid="toggle-sidebar"]');
    expect(toggle.x + toggle.width).toBeLessThanOrEqual(sidebar.x + sidebar.width + 0.5);
    if (SHOTS) {
      await page
        .locator('.sidebar')
        .screenshot({ path: `${SHOTS}/pen-135-8-narrowest-browser.png` });
    }
    expect(errors).toEqual([]);
  });
});
