import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from './fixtures';

// T80.8 (#291, A1196): Settings → Updates on the Mac has Update Channel, Stable (the default) or
// Alpha. Stable reads latest-mac.yml on GitHub's latest release, and Alpha alpha-mac.yml on the
// alpha prerelease. Choosing one is kept in updates.json, checks at once (Auto-Update on or off)
// and only offers the build; downgrades stay off. The stand-in Mac runs apps/desktop's `Updates`
// over a fake electron-updater (support/git-host.ts).

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const STABLE = 'https://github.com/htxryan/penmoss/releases/latest/download';
const ALPHA = 'https://github.com/htxryan/penmoss/releases/download/alpha';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

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
  await expect(settings).toContainText('This is version 0.2.0.');
  await expect(settings).toContainText('New builds come from GitHub Releases.');
  await expect(settings.getByRole('group', { name: 'Update Channel' })).toBeVisible();
  await expect(channel(page).getByRole('radio', { name: 'Stable' })).toBeChecked();
  await expect(channel(page).getByRole('radio', { name: 'Alpha' })).not.toBeChecked();
  await expect(channel(page).getByRole('radio', { name: 'Alpha' })).toHaveAccessibleDescription(
    'Alpha: Every build from main. Newest features, may break.',
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

  // Alpha, with Auto-Update off: checks the Alpha feed at once and offers its build.
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
