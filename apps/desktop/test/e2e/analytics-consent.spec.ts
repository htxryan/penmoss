import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import {
  analyticsEnv,
  analyticsStatus,
  canaryHits,
  CANARIES,
  fakeAnalytics,
  sendNow,
  type FakeAnalytics,
} from './fake-analytics';
import {
  bareRepository,
  firstRunName,
  firstRunPasteUrl,
  gitNotebook,
  go,
  holdForProof,
  launch,
  mainBounds,
  notebookSection,
  removeDataDirs,
  type Launched,
} from './support';

// PEN-137 in the Mac app: the usage question. A first run ends with it, "Last Step", Share Usage
// Data and Don't Share the same kind of button (ac1); Share sends what was recorded before the
// answer, the first run's steps among it, to the endpoint (AC12), by name only (AC14). An install
// that had a notebook before this build and has no answer is asked once, in a dialog over the app
// (ac8); after Don't Share it is never asked again, and nothing reaches the endpoint (AC11). The
// endpoint is a stand-in on loopback (fake-analytics.ts). The web suite has the same steps against
// a stand-in bridge (apps/web/test/e2e/analytics.spec.ts).

const opened: Launched[] = [];
const endpoints: FakeAnalytics[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});
test.afterAll(() => removeDataDirs());

async function endpoint(): Promise<FakeAnalytics> {
  const started = await fakeAnalytics();
  endpoints.push(started);
  return started;
}

/** The two answers are the same kind of button: same classes, neither focused, neither primary. */
async function expectEqualAnswers(scope: Locator) {
  const share = scope.getByRole('button', { name: 'Share Usage Data' });
  const dont = scope.getByRole('button', { name: 'Don’t Share' });
  await expect(share).toBeVisible();
  await expect(dont).toBeVisible();
  expect(await share.getAttribute('class')).toBe(await dont.getAttribute('class'));
  await expect(share).not.toHaveClass(/primary/);
  await expect(dont).not.toHaveClass(/primary/);
  await expect(share).not.toBeFocused();
  await expect(dont).not.toBeFocused();
}

/** What the question says, wherever it is asked (ac1, ac8): the Mac's list has the CLI's line. */
async function expectQuestion(scope: Locator) {
  await expect(scope.getByRole('heading', { name: 'Share How You Use Penmoss?' })).toBeVisible();
  await expect(scope.getByTestId('consent-question')).toContainText(
    'Share Usage Data sends it, this setup included, to Penmoss’s developer.',
  );
  await expect(scope.getByRole('heading', { name: 'What Is Recorded' })).toBeVisible();
  await expect(scope.getByRole('heading', { name: 'Never Recorded' })).toBeVisible();
  await expect(scope.getByTestId('consent-recorded')).toContainText(
    'CLI commands and agents’ MCP calls, by name',
  );
  await expect(scope.getByTestId('consent-never')).toContainText(
    'What you write: notes, titles, tags, links and searches',
  );
  await expect(scope.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
    'href',
    'https://penmoss.app/privacy/',
  );
}

test('a first run ends with the usage question; Share sends the setup’s steps, by name (ac1, AC12)', async () => {
  test.setTimeout(180_000);
  const fake = await endpoint();
  const launched = await launch({ analytics: 'ask', env: analyticsEnv(fake) });
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });

  // First Run C: Paste a URL, then Name Your Notebook, with the canary notebook's name.
  const remote = bareRepository();
  await firstRunPasteUrl(page, `file://${remote}`);
  await firstRunName(page, CANARIES.notebook);

  // Set up and synced: the question, as the last step, not yet the app.
  const firstRun = page.getByTestId('first-run');
  const consent = firstRun.getByTestId('first-run-consent');
  await expect(consent).toBeVisible({ timeout: 60_000 });
  await expect(consent.getByRole('heading', { name: 'Share How You Use Penmoss?' })).toBeFocused();
  await expect(consent.locator('.fr-step')).toHaveText('Last Step');
  await expect(consent).not.toContainText('Step 3 of 3');
  await expectQuestion(consent);
  await expectEqualAnswers(consent);
  await expect(consent.getByTestId('first-run-back')).toHaveCount(0);
  // Escape answers nothing, and the app stays held back.
  await page.keyboard.press('Escape');
  await expect(consent).toBeVisible();
  await expect(page.getByTestId('note-title')).toHaveCount(0);
  expect((await analyticsStatus(page)).consent).toBeNull();
  // Nothing has left the Mac before the answer.
  await sendNow(app);
  expect(fake.requests).toEqual([]);
  await holdForProof(page);

  await consent.getByRole('button', { name: 'Share Usage Data' }).click();
  await expect(page.getByTestId('first-run')).toHaveCount(0, { timeout: 30_000 });
  await expect(notebookSection(page, CANARIES.notebook)).toBeVisible({ timeout: 30_000 });
  expect((await analyticsStatus(page)).consent).toBe('yes');

  // What was recorded before the answer goes with Yes: the first run's steps, by name.
  const firstRunSteps = () =>
    fake
      .events()
      .filter((event) => event.kind === 'firstrun')
      .map((event) => `${event.name}:${String(event.props['result'])}`);
  await expect
    .poll(
      async () => {
        await sendNow(app);
        return firstRunSteps();
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toEqual(
      expect.arrayContaining([
        'welcome:done',
        'goal:done',
        'way:done',
        'url:done',
        'name:done',
        'setup:done',
      ]),
    );
  // Recorded before the answer: every step's time is before sharing began.
  const status = await analyticsStatus(page);
  expect(status.sharingSince).not.toBeNull();
  const steps = fake
    .events()
    .filter((event) => event.kind === 'firstrun' && event.name !== 'consent');
  expect(steps.every((event) => event.at <= status.sharingSince!)).toBe(true);
  expect(fake.batches.every((batch) => batch.install === status.install)).toBe(true);
  // Names only: no notebook name, no remote, nothing of the canary notebook (AC14).
  for (const body of fake.bodies) {
    expect(canaryHits(body, [CANARIES.pattern])).toEqual([]);
    expect(body).not.toContain(remote);
  }
  expect(fake.requests.every((request) => request === 'POST /v1/batch')).toBe(true);

  // On screen: the record, the first run's steps among what was sent.
  await go(page, '/settings/privacy/data');
  const data = page.getByTestId('analytics-data');
  await expect(data.getByRole('heading', { level: 1 })).toHaveText('Analytics Data');
  await data.getByTestId('analytics-data-state').getByText('Sent', { exact: true }).click();
  const rows = data.getByTestId('analytics-data-row');
  await expect(rows.first()).toBeVisible();
  await expect(rows.locator('td:nth-child(6)').first()).toHaveText('Sent');
  // Newest first: the first run's steps may be a page or two back.
  const firstRunRow = rows.filter({
    has: page.locator('td:nth-child(3)', { hasText: 'firstrun' }),
  });
  const earlier = data.getByTestId('analytics-data-earlier');
  for (let pages = 0; pages < 5 && (await firstRunRow.count()) === 0; pages++) {
    if (await earlier.isDisabled()) break;
    const showing = await data.getByTestId('analytics-data-showing').textContent();
    await earlier.click();
    await expect(data.getByTestId('analytics-data-showing')).not.toHaveText(showing ?? '');
  }
  await expect(firstRunRow.first()).toBeVisible();
  await firstRunRow.first().scrollIntoViewIfNeeded();
  await holdForProof(page);
});

test('an install with a notebook and no answer is asked once; Don’t Share sends nothing, ever (ac8, AC11)', async () => {
  test.setTimeout(240_000);
  const fake = await endpoint();
  // Before this build: a notebook, and no answer (support.ts answers No; the file goes).
  const before = await launch({ env: analyticsEnv(fake) });
  await gitNotebook(before);
  await before.app.close();
  rmSync(join(before.home, 'analytics.json'), { force: true });

  // This build: the question once, over the app.
  const launched = await launch({
    userData: before.userData,
    analytics: 'ask',
    env: analyticsEnv(fake),
  });
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  const dialog = page.getByTestId('consent-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toHaveAttribute('open', '');
  await expectQuestion(dialog);
  await expectEqualAnswers(dialog);
  // Escape does not close it.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  expect((await analyticsStatus(page)).consent).toBeNull();
  await holdForProof(page);

  await dialog.getByRole('button', { name: 'Don’t Share' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await analyticsStatus(page)).consent).toBe('no');
  // What waited for the answer stays on this Mac: Not Shared, and never sent.
  const counts = (await analyticsStatus(page)).counts;
  expect(counts.pending).toBe(0);
  expect(counts.waiting).toBe(0);
  expect(counts.local).toBeGreaterThan(0);
  await sendNow(app);
  await app.close();
  opened.splice(opened.indexOf(launched), 1);

  // Never asked again.
  const again = await launch({
    userData: before.userData,
    analytics: 'ask',
    env: analyticsEnv(fake),
  });
  opened.push(again);
  await mainBounds(again.app, { x: 0, y: 0, width: 1280, height: 720 });
  await expect(notebookSection(again.page, 'Notes')).toBeVisible({ timeout: 30_000 });
  // A check that something didn't happen: the status is read as the app mounts.
  await again.page.waitForTimeout(2_000);
  await expect(again.page.getByTestId('consent-dialog')).toHaveCount(0);

  // Nothing reached the endpoint, then or now (AC11).
  await sendNow(again.app);
  await again.page.waitForTimeout(1_000);
  expect(fake.requests).toEqual([]);

  // On screen: Settings → Privacy, sharing off, the record Not Shared.
  await go(again.page, '/settings/privacy');
  const section = again.page.getByTestId('privacy-settings');
  await expect(again.page.getByRole('switch', { name: 'Share Usage Data' })).not.toBeChecked();
  await expect(section.getByTestId('privacy-counts')).toHaveText(/^Not Shared [\d,]+$/);
  await section.getByTestId('privacy-counts').scrollIntoViewIfNeeded();
  await holdForProof(again.page);
});
