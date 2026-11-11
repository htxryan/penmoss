import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { dataDir, gitNotebook, go, launch, removeDataDirs, type Launched } from './support';

// PEN-108 in the Mac app: Settings → Updates shows the release notes main keeps in userData
// (`release-notes.json`), placed by this app's version: this version's notes grouped by kind,
// and earlier versions collapsed. A development build never fetches the file, so the suite
// writes the cache and launches offline; the offered update's block is the web component test's
// (apps/web/test/unit/updates-notes.test.tsx), since an unsigned build is never offered one.

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

const FILE = {
  schema: 1,
  generated: '2026-11-20T00:00:00Z',
  head: 'abc',
  prs: [],
  releases: [
    { version: '0.2.0', tag: 'v0.2.0', build: 1170, date: '2026-11-08' },
    { version: '0.2.1', tag: 'v0.2.1', build: 1180, date: '2026-11-20' },
  ],
  notes: [
    { build: 1165, pr: 165, kind: 'new', platform: null, text: 'Quick capture from the menu bar.' },
    {
      build: 1174,
      pr: 174,
      kind: 'new',
      platform: null,
      text: 'Settings → Updates shows what changed in each version.',
    },
    {
      build: 1176,
      pr: 176,
      kind: 'fixed',
      platform: 'android',
      text: 'The keyboard no longer hides the last line.',
    },
    { build: 1177, pr: 177, kind: 'improved', platform: null, text: 'Search ranks titles first.' },
    {
      build: 1178,
      pr: 178,
      kind: 'fixed',
      platform: 'mac',
      text: 'The window keeps its size after a restart.',
    },
  ],
};

for (const mode of ['light', 'dark'] as const) {
  test(`Settings → Updates shows this version's release notes and earlier versions (${mode})`, async () => {
    const userData = dataDir();
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, 'release-notes.json'), JSON.stringify(FILE));
    const launched = await launch({
      userData,
      offline: true,
      env: { PENMOSS_TEST_APP_VERSION: '0.2.1' },
    });
    opened.push(launched);
    const { page, errors } = launched;
    await page.emulateMedia({ colorScheme: mode });
    await gitNotebook(launched);
    await go(page, '/settings/updates');
    await expect(page.locator('html')).toHaveAttribute('data-mode', mode);

    const current = page.getByTestId('release-notes-current');
    await expect(current.getByRole('heading', { level: 3 })).toHaveText('In this version');
    await expect(current.getByRole('heading', { level: 4 })).toHaveText([
      'New',
      'Improved',
      'Fixed',
    ]);
    await expect(current.getByRole('listitem')).toHaveText([
      'Settings → Updates shows what changed in each version.',
      'Search ranks titles first.',
      'The window keeps its size after a restart.',
    ]);
    // Android's notes stay on Android.
    await expect(page.getByText('The keyboard no longer hides the last line.')).toHaveCount(0);

    const earlier = page.getByTestId('release-notes-earlier');
    await expect(earlier.getByText('Quick capture from the menu bar.')).toBeHidden();
    await earlier.getByText('Earlier versions').click();
    await expect(earlier.getByRole('heading', { level: 3 })).toHaveText('0.2.0');
    await expect(earlier.getByText('Quick capture from the menu bar.')).toBeVisible();

    if (SHOTS) {
      await page.getByTestId('updates-settings').screenshot({
        path: join(SHOTS, `release-notes-${mode}.png`),
      });
    }
    expect(errors).toEqual([]);
  });
}

test('without a release-notes file, Settings → Updates links to GitHub', async () => {
  const launched = await launch({ offline: true, env: { PENMOSS_TEST_APP_VERSION: '0.2.1' } });
  opened.push(launched);
  const { page } = launched;
  await gitNotebook(launched);
  await go(page, '/settings/updates');
  const missing = page.getByTestId('release-notes-missing');
  await expect(missing).toContainText('Release notes show once Penmoss can reach GitHub');
  await expect(missing.getByRole('link')).toHaveAttribute(
    'href',
    'https://github.com/htxryan/penmoss/releases',
  );
});
