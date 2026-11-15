// Updates: the channel, Update Automatically, the notice after an update and a build on offer.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, test } from './fixtures';
import { collectErrors } from './support/app';
import { type DesktopReleaseNotes } from '../../src/desktop/bridge';

const SHOTS = process.env['PENMOSS_EVIDENCE'];
test.describe('in Quanta, with notes of links, lists and headings', () => {
  test.use({
    seed: {
      name: 'Quanta',
      notes: [
        { title: 'Links', markdown: 'See the docs here.\n' },
        {
          title: 'Outline',
          markdown: '1. one\n   1. two\n      1. three\n         1. four\n2. five\n',
        },
        { title: 'Lists', markdown: '1. one\n2. two\n3. three\n' },
        { title: 'Heading', markdown: 'first line\n\nsecond line\n' },
      ],
    },
  });

  // Ryan’s feedback of 6 Nov 2026 (Quanta), item 2.
  test('Update Automatically is a switch in Settings → Updates; a newer build is offered, then installed', async ({
    page,
    host,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/settings/updates');
    const settings = page.getByTestId('updates-settings');
    // PEN-146: the version card first, then the two settings as rows.
    await expect(settings.getByTestId('updates-version')).toContainText('Penmoss 0.1.435');
    const auto = settings.getByTestId('updates-auto');
    await expect(auto).not.toBeChecked();
    await expect(auto).toBeEnabled();
    await page.waitForTimeout(300);
    expect(host.updateFeed.checks).toBe(0);

    // Check Now with nothing newer.
    await settings.getByTestId('updates-check').click();
    await expect(settings.getByTestId('updates-status')).toHaveText('Penmoss is up to date.');
    expect(host.updateFeed.checks).toBe(1);

    // Turned on, it checks at once (and hourly after): build 440 is offered, not downloaded.
    host.updateFeed.offered = '0.1.440';
    await auto.check();
    await expect(auto).toBeChecked();
    // Settings shows it in its section; the notes' window shows the notice.
    await expect(settings.getByTestId('updates-status')).toHaveText('Build 440 is available.');
    await expect(settings.getByTestId('updates-install')).toBeVisible();
    expect(host.updateFeed.installs).toBe(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/updates.png` });
    await page.goto('/');
    await expect(page.getByTestId('update-notice')).toContainText('Build 440 is available.');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/update-notice.png` });

    // Install and Restart: downloads with progress, then restarts into it.
    await page.getByTestId('update-install').click();
    await expect(page.getByTestId('update-notice')).toContainText(/Downloading build 440… \d+%/);
    await expect.poll(() => host.updateFeed.installs).toBe(1);
    await expect(page.getByTestId('update-notice')).toContainText('Build 440 is downloaded');

    // The switch is remembered (this Mac's userData).
    await page.goto('/settings/updates');
    await expect(page.getByTestId('updates-auto')).toBeChecked();
    expect(errors).toEqual([]);
  });
});

const tree = (page: Page) =>
  page
    .getByTestId('source-section')
    .and(page.getByRole('region', { name: 'Quanta', exact: true }))
    .getByRole('tree', { name: 'Folders and notes' });

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  expect(found, selector).not.toBeNull();
  return found!;
};

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

/** release-notes.json with notes for the Alpha build this Mac runs (PEN-108). */
const NOTES: DesktopReleaseNotes = {
  schema: 1,
  generated: '2026-11-13T00:00:00Z',
  releases: [{ version: '0.2.0', tag: 'v0.2.0', build: 1170, date: '2026-11-08' }],
  notes: [
    { build: 1305, pr: 305, kind: 'new', platform: null, text: 'The notice in the sidebar.' },
  ],
};
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

  // PEN-135, item 10.
  test('after an update, the notice is in the sidebar’s bottom panel, an icon on the rail', async ({
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
    const railFeedback = await box(page, '[data-testid="sidebar-feedback"]');
    expect(at.y + at.height).toBeCloseTo(railFeedback.y, 0);
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
  // PEN-135, item 10.
  test('dismissing the notice in the sidebar answers it; a narrow window shows it as a toast', async ({
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
  // PEN-135, item 10.
  test('a build on offer is in the sidebar with Install and Restart; on the rail it leads to Settings', async ({
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
});

const STABLE = 'https://github.com/htxryan/penmoss/releases/latest/download';

const ALPHA = 'https://github.com/htxryan/penmoss/releases/download/alpha';

const channel = (page: Page) => page.getByTestId('updates-channel');

test('Update Channel is Stable by default; Alpha is kept, checks at once and only offers', async ({
  page,
  host,
}) => {
  const errors = collectErrors(page);
  host.appVersion = '0.2.0';
  host.updateFeed.offeredAlpha = '0.2.1-alpha.12';
  await page.goto('/settings/updates');
  const settings = page.getByTestId('updates-settings');
  // PEN-146: the version card first, then the two settings as rows.
  await expect(settings.getByTestId('updates-version')).toContainText('Penmoss 0.2.0');
  await expect(settings.getByRole('group', { name: 'Update Channel' })).toBeVisible();
  await expect(channel(page).getByRole('radio', { name: 'Stable' })).toBeChecked();
  await expect(channel(page).getByRole('radio', { name: 'Alpha' })).not.toBeChecked();
  await expect(channel(page).getByRole('radio', { name: 'Alpha' })).toHaveAccessibleDescription(
    'Alpha gets every build from main: newest features, may break.',
  );
  await expect(settings.getByTestId('updates-auto')).not.toBeChecked();
  expect(host.updateFeed.checks).toBe(0);
  if (SHOTS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${SHOTS}/update-channel-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }

  // Alpha, with Update Automatically off: checks the Alpha feed at once and offers its build.
  await channel(page).getByText('Alpha', { exact: true }).click();
  await expect(channel(page).getByRole('radio', { name: 'Alpha' })).toBeChecked();
  await expect(settings.getByTestId('updates-status')).toHaveText(
    'Version 0.2.1-alpha.12 is available.',
  );
  await expect(settings.getByTestId('updates-install')).toBeVisible();
  expect(host.updateFeed.checks).toBe(1);
  expect(host.updateFeed.checked).toEqual([ALPHA]);
  expect(host.updateFeed.channel).toBe('alpha');
  expect(host.updateFeed.allowDowngrade).toBe(false);
  // Only offered: nothing is installed.
  expect(host.updateFeed.installs).toBe(0);
  expect(JSON.parse(await readFile(join(host.root, 'userData', 'updates.json'), 'utf8'))).toEqual({
    auto: false,
    channel: 'alpha',
    // The version Penmoss last said it updated to (PEN-110): a first launch records its own.
    lastSeenVersion: '0.2.0',
  });
  if (SHOTS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${SHOTS}/update-channel-alpha-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }

  // Back to Stable: nothing newer there, and what Alpha offered is gone.
  await channel(page).getByText('Stable', { exact: true }).click();
  await expect(settings.getByTestId('updates-status')).toHaveText('Penmoss is up to date.');
  await expect(settings.getByTestId('updates-chip')).toHaveText('Up to Date');
  await expect(settings.getByTestId('updates-checked')).toHaveText(/^Stable · checked /);
  await expect(settings.getByTestId('updates-install')).toBeHidden();
  expect(host.updateFeed.checked).toEqual([ALPHA, STABLE]);
  expect(host.updateFeed.channel).toBe('latest');
  expect(host.updateFeed.allowDowngrade).toBe(false);

  // The choice is remembered (this Mac's userData).
  await channel(page).getByText('Alpha', { exact: true }).click();
  await expect(settings.getByTestId('updates-status')).toHaveText(
    'Version 0.2.1-alpha.12 is available.',
  );
  await page.reload();
  await expect(channel(page).getByRole('radio', { name: 'Alpha' })).toBeChecked();
  expect(errors).toEqual([]);
});

test('an Alpha build switched to Stable says it moves to Stable with the next stable release', async ({
  page,
  host,
}) => {
  const errors = collectErrors(page);
  host.appVersion = '0.2.1-alpha.12';
  await page.goto('/settings/updates');
  const settings = page.getByTestId('updates-settings');
  await expect(settings).toContainText('This is version 0.2.1-alpha.12.');
  await channel(page).getByText('Alpha', { exact: true }).click();
  await expect(settings.getByTestId('updates-status')).toHaveText('Penmoss is up to date.');

  // Stable's newest release (0.2.0) is older than this build, so nothing is offered.
  await channel(page).getByText('Stable', { exact: true }).click();
  await expect(settings.getByTestId('updates-status')).toHaveText(
    'This is an Alpha build: Penmoss moves to Stable with the next stable release.',
  );
  await expect(settings.getByTestId('updates-install')).toBeHidden();
  expect(host.updateFeed.checked).toEqual([ALPHA, STABLE]);
  expect(host.updateFeed.allowDowngrade).toBe(false);
  if (SHOTS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${SHOTS}/update-channel-to-stable-${scheme}.png` });
    }
  }
  expect(errors).toEqual([]);
});
