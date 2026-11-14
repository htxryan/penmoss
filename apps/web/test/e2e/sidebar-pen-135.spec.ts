import type { DesktopReleaseNotes } from '../../src/desktop/bridge';
import { expect, test, type Page } from './fixtures';

// PEN-135 (Ryan's feedback, items 4, 6, 7, 8 and 10), in the web app with the Mac app's window
// (`macWindow`: Keep on Top's pin and the compact title bar): Settings and Send Feedback at the
// rail's foot (4); Back, Forward and the pin at the start of a note's title bar beside the rail
// (6); the note's title bar in the sidebar's colour (7); the sidebar's head never clipping its
// buttons (8); the update notice in the sidebar's bottom panel, an icon on the rail (10).

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
/** The traffic lights' room in a compact window (`--pm-titlebar-inset`, A722). */
const INSET = 88;

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

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const tree = (page: Page) =>
  page
    .getByTestId('source-section')
    .and(page.getByRole('region', { name: 'Quanta', exact: true }))
    .getByRole('tree', { name: 'Folders and notes' });

async function openNote(page: Page, title: string): Promise<void> {
  await tree(page).getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  expect(found, selector).not.toBeNull();
  return found!;
};

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

async function chooseMode(page: Page, mode: 'Light' | 'Dark'): Promise<void> {
  await page.goto('/settings/appearance');
  await page.getByTestId('theme-mode').getByText(mode).click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', mode.toLowerCase());
  await page.goto('/');
  await expect(tree(page)).toBeVisible({ timeout: 30_000 });
}

/** The computed background colour of the first element `selector` matches. */
const background = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);

test('4: the rail keeps Settings and Send Feedback at its foot', async ({ page }) => {
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
  // A column at the rail's foot, each the rail's width, Settings above Feedback.
  expect(f.y + f.height).toBeCloseTo(rail.y + rail.height, 0);
  expect(s.y + s.height).toBeCloseTo(f.y, 0);
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

test('6: beside the rail, Back, Forward and the pin start the note’s title bar, after the lights', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(tree(page)).toBeVisible({ timeout: 30_000 });
  await compact(page);
  await openNote(page, 'Alpha');
  await openNote(page, 'Bravo');
  // Open: in the sidebar's head.
  const head = page.locator('.sb-head');
  await expect(head.getByTestId('app-back')).toBeVisible();
  await expect(head.getByTestId('keep-on-top')).toBeVisible();

  await collapse(page);
  const lead = page.locator('.note-top > .note-top-lead');
  for (const id of ['app-back', 'app-forward', 'keep-on-top']) {
    await expect(lead.getByTestId(id), id).toBeVisible();
    await expect(page.locator('.sidebar').getByTestId(id), id).toHaveCount(0);
  }
  // The rail keeps the toggle, below the lights' row.
  const toggle = await box(page, '[data-testid="toggle-sidebar"]');
  expect(toggle.y).toBeGreaterThanOrEqual(48);
  // At the bar's start, after the lights' room, then the crumbs.
  const back = await box(page, '.note-top [data-testid="app-back"]');
  const forward = await box(page, '.note-top [data-testid="app-forward"]');
  const pin = await box(page, '.note-top [data-testid="keep-on-top"]');
  const crumbs = await box(page, '.note-top .crumbs');
  const bar = await box(page, '.note-top');
  expect(back.x).toBeGreaterThanOrEqual(INSET);
  expect(back.x).toBeLessThan(INSET + 4);
  expect(forward.x).toBeGreaterThan(back.x);
  expect(pin.x).toBeGreaterThanOrEqual(forward.x + forward.width - 1);
  expect(crumbs.x).toBeGreaterThan(pin.x + pin.width);
  // As tall as the row, flush with it.
  for (const button of [back, forward, pin]) {
    expect(button.y).toBeCloseTo(bar.y, 0);
    expect(button.height).toBeCloseTo(bar.height - 1, 0);
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-6-compact.png` });
  // They work there: Back to Alpha, Forward to Bravo, the pin pins the window.
  await page.locator('.note-top').getByTestId('app-back').click();
  await expect(page.getByTestId('note-title')).toHaveValue('Alpha');
  await page.locator('.note-top').getByTestId('app-forward').click();
  await expect(page.getByTestId('note-title')).toHaveValue('Bravo');
  const pinButton = page.locator('.note-top').getByTestId('keep-on-top');
  await pinButton.click();
  await expect(pinButton).toHaveAttribute('aria-pressed', 'true');
  await pinButton.click();
  await expect(pinButton).toHaveAttribute('aria-pressed', 'false');

  // Without the compact title bar (a browser, the native title bar, full screen): from the
  // rail's edge.
  await page.evaluate(() => delete document.documentElement.dataset['titlebar']);
  const rail = await box(page, '.sidebar');
  const flush = await box(page, '.note-top [data-testid="app-back"]');
  expect(flush.x).toBeCloseTo(rail.x + rail.width, 0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-6-browser.png` });

  // The graph (as Home and Trash) has no note's title bar: there the rail keeps them.
  await page.locator('.sidebar [data-command="app.graph"]').click();
  await expect(page.locator('.graph-page')).toBeVisible();
  await expect(page.locator('.sidebar').getByTestId('app-back')).toBeVisible();
  await expect(page.locator('.note-top')).toHaveCount(0);
  // A note that is not there still has the bar, with them.
  await page.goto('/notes/01ZZZZZZZZZZZZZZZZZZZZZZZZ');
  await expect(page.getByTestId('note-not-found')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.note-top').getByTestId('app-back')).toBeVisible();
  await expect(page.locator('.sidebar').getByTestId('app-back')).toHaveCount(0);
  await expand(page);
  await expect(head.getByTestId('app-back')).toBeVisible();
  expect(errors).toEqual([]);
});

for (const mode of ['Light', 'Dark'] as const) {
  test(`7: the note’s title bar is in the sidebar’s colour, apart from the text (${mode})`, async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await chooseMode(page, mode);
    await openNote(page, 'Alpha');
    const sidebar = await background(page, '.sidebar');
    expect(await background(page, '.note-top')).toBe(sidebar);
    expect(await background(page, 'body')).not.toBe(sidebar);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-7-${mode.toLowerCase()}.png` });
    // Beside the rail in the compact window, the row over the rail's column takes it too.
    await collapse(page);
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/pen-135-7-${mode.toLowerCase()}-rail.png` });
    }
    await expand(page);
    expect(errors).toEqual([]);
  });
}

test('8: the sidebar’s head never clips its buttons, however narrow the sidebar', async ({
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
    await page.locator('.sidebar').screenshot({ path: `${SHOTS}/pen-135-8-narrowest-browser.png` });
  }
  expect(errors).toEqual([]);
});

/** release-notes.json with notes for the Alpha build this Mac runs (PEN-108). */
const NOTES: DesktopReleaseNotes = {
  schema: 1,
  generated: '2026-11-13T00:00:00Z',
  releases: [{ version: '0.2.0', tag: 'v0.2.0', build: 1170, date: '2026-11-08' }],
  notes: [
    { build: 1305, pr: 305, kind: 'new', platform: null, text: 'The notice in the sidebar.' },
  ],
};

test('10: after an update, the notice is in the sidebar’s bottom panel, an icon on the rail', async ({
  page,
  host,
}) => {
  const errors = collectErrors(page);
  host.appVersion = '0.2.1-alpha.1313';
  host.updatedFrom('0.2.1-alpha.1300', NOTES);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(tree(page)).toBeVisible({ timeout: 30_000 });
  const foot = page.locator('.sb-foot');
  const notice = foot.getByTestId('updated-notice');
  await expect(notice).toContainText('Updated to build 1313.');
  await expect(notice.getByRole('button', { name: "What's New" })).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Dismiss' })).toBeVisible();
  // Not a toast any more; above Settings and Feedback, the sidebar's width.
  await expect(page.locator('.toast')).toHaveCount(0);
  const line = await box(page, '.sb-foot [data-testid="updated-notice"]');
  const settings = await box(page, '[data-testid="sidebar-settings"]');
  const sidebar = await box(page, '.sidebar');
  expect(line.y + line.height).toBeLessThanOrEqual(settings.y + 0.5);
  expect(line.width).toBeCloseTo(sidebar.width - 1, 0);
  // Compact: the line and its action under it.
  expect(line.height).toBeLessThan(64);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-10-sidebar.png` });

  // On the rail: one icon with a dot, named for what it does.
  await collapse(page);
  const icon = page.locator('.sidebar').getByTestId('updated-notice');
  await expect(icon).toHaveAccessibleName("Updated to build 1313: What's New");
  await expect(icon.locator('.sb-update-badge')).toBeVisible();
  const at = (await icon.boundingBox())!;
  const railSettings = await box(page, '[data-testid="sidebar-settings"]');
  expect(at.y + at.height).toBeCloseTo(railSettings.y, 0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-10-rail.png` });
  // It opens What's New, and the notice is answered.
  await icon.click();
  await expect(page).toHaveURL(/\/settings\/updates\?whats-new$/);
  await page.goto('/');
  await expect(tree(page).or(page.locator('.sidebar'))).toBeVisible();
  await expect(page.getByTestId('updated-notice')).toHaveCount(0);
  await expand(page);
  await expect(page.getByTestId('updated-notice')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('10: dismissing the notice in the sidebar answers it; a narrow window shows it as a toast', async ({
  page,
  host,
}) => {
  const errors = collectErrors(page);
  host.appVersion = '0.2.1-alpha.1313';
  host.updatedFrom('0.2.1-alpha.1300', NOTES);
  // A narrow window: the sidebar is a drawer, so the notice is a toast.
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto('/');
  const toast = page.locator('.toast').getByText('Updated to build 1313.');
  await expect(toast).toBeVisible({ timeout: 30_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-10-narrow.png` });
  // Wide again: the same notice moves to the sidebar.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('.toast')).toHaveCount(0);
  const notice = page.locator('.sb-foot').getByTestId('updated-notice');
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('updated-notice')).toHaveCount(0);
  await page.reload();
  await expect(tree(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('updated-notice')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('10: a build on offer is in the sidebar with Install and Restart; on the rail it leads to Settings', async ({
  page,
  host,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/settings/updates');
  host.updateFeed.offered = '0.1.440';
  await page.getByTestId('updates-check').click();
  await expect(page.getByTestId('updates-status')).toHaveText('Build 440 is available.');
  await page.goto('/');
  const notice = page.locator('.sb-foot').getByTestId('update-notice');
  await expect(notice).toContainText('Build 440 is available.');
  await expect(notice.getByTestId('update-install')).toHaveText('Install and Restart');
  await expect(page.locator('.toast')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-10-offered.png` });
  // In dark mode too, and on the rail.
  await chooseMode(page, 'Dark');
  await expect(notice).toContainText('Build 440 is available.');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-10-offered-dark.png` });
  await collapse(page);
  const icon = page.locator('.sidebar').getByTestId('update-notice');
  await expect(icon).toHaveAccessibleName('Build 440 is available: Settings → Updates');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-10-offered-dark-rail.png` });
  await icon.click();
  await expect(page).toHaveURL(/\/settings\/updates$/);
  await expect(page.getByTestId('updates-install')).toBeVisible();
  await page.goBack();
  await expand(page);
  expect(errors).toEqual([]);
});
