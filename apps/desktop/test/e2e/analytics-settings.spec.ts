import { expect, test, type Page } from '@playwright/test';
import {
  analyticsEnv,
  analyticsStatus,
  fakeAnalytics,
  seedEvents,
  sendNow,
  type FakeAnalytics,
} from './fake-analytics';
import {
  gitNotebook,
  go,
  holdForProof,
  launch,
  mainBounds,
  removeDataDirs,
  type Launched,
} from './support';

// PEN-137 in the Mac app: Settings → Privacy. It is the last page of This Mac, after Updates,
// with the shield, its rows in order and Advanced closed (ac2); View Analytics Data opens
// Analytics Data, its own page under Privacy, which pages the record on this Mac 100 at a time,
// newest first, filtered by state and client, and copies the last batch sent (ac36); turning
// sharing off makes what waits Not Shared at once (AC16); Delete My Shared Data asks first,
// under the button, and only Delete asks the endpoint to forget the ID (ac37). The endpoint is a
// stand-in on loopback (fake-analytics.ts); the web suite has the same steps against a stand-in
// bridge (apps/web/test/e2e/analytics.spec.ts).

const opened: Launched[] = [];
const endpoints: FakeAnalytics[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});
test.afterAll(() => removeDataDirs());

const nav = (page: Page) => page.getByRole('navigation', { name: 'Settings Sections' });

/** The Mac app, sharing usage data with the stand-in, with a notebook. */
async function sharing(): Promise<Launched & { fake: FakeAnalytics }> {
  const fake = await fakeAnalytics();
  endpoints.push(fake);
  const launched = await launch({ analytics: 'yes', env: analyticsEnv(fake) });
  opened.push(launched);
  await mainBounds(launched.app, { x: 0, y: 0, width: 1280, height: 720 });
  await gitNotebook(launched);
  return { ...launched, fake };
}

test('Privacy is the last page of This Mac; Analytics Data pages the record; Off keeps what waits here (ac2, ac36, AC16)', async () => {
  test.setTimeout(180_000);
  const { app, page, fake } = await sharing();
  // More than a page of the record, all sent.
  await seedEvents(page, 150);
  await expect
    .poll(
      async () => {
        await sendNow(app);
        return fake.events().length;
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBeGreaterThanOrEqual(150);
  await expect.poll(async () => (await analyticsStatus(page)).counts.sent).toBeGreaterThan(100);

  // This Mac: … Updates, then Privacy with its shield, and Analytics Data under it.
  await go(page, '/settings');
  const mac = nav(page).getByRole('group', { name: /This Mac/ });
  await expect(mac.getByRole('link', { name: 'Privacy', exact: true })).toBeVisible();
  const links = await mac.getByRole('link').allTextContents();
  expect(links.slice(-3).map((text) => text.trim())).toEqual([
    'Updates',
    'Privacy',
    'Analytics Data',
  ]);
  expect(links.map((text) => text.trim())).toContain('GitHub');
  const privacy = mac.getByRole('link', { name: 'Privacy', exact: true });
  await privacy.click();
  await expect(page).toHaveURL(/\/settings\/privacy$/);
  // Its icon: the outline shield with a tick.
  await expect(privacy.locator('svg path[d^="M12 3.5 19 6"]')).toHaveCount(1);
  await expect(privacy).toHaveAttribute('aria-current', 'page');
  await expect(mac.getByTestId('settings-privacy-data-entry')).not.toHaveAttribute('aria-current');

  const section = page.getByTestId('privacy-settings');
  await expect(section.getByRole('heading', { level: 1 })).toHaveText('Privacy');
  await expect(section.getByTestId('settings-intro')).toHaveCount(0);
  expect(
    await section
      .locator('.lf-group > [data-setting], [data-setting="advanced"]')
      .evaluateAll((all) => all.map((row) => row.getAttribute('data-setting'))),
  ).toEqual(['share-usage-data', 'view-analytics-data', 'analytics-id', 'logs', 'advanced']);
  const share = page.getByRole('switch', { name: 'Share Usage Data' });
  await expect(share).toBeChecked();
  await expect(section.getByTestId('privacy-counts')).toContainText(/Sent [\d,]+/);
  await expect(section.getByTestId('privacy-id')).toHaveText(/^[0-9a-f]{8}…[0-9a-f]{4}$/);
  await expect(section.getByRole('button', { name: 'Reset My Analytics ID' })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Delete My Shared Data' })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Show Log File' })).toBeVisible();
  await expect(section.locator('[data-setting="logs"]')).toContainText(
    'The last 7 days, on this Mac. They leave only when you attach them to a bug report.',
  );
  await expect(section.getByTestId('privacy-advanced')).not.toHaveAttribute('open');
  // Closed, Advanced says what is inside it.
  await expect(section.getByTestId('privacy-advanced-hint')).toHaveText(
    'How long and how much Penmoss keeps on this Mac',
  );
  await expect(section.getByLabel('Keep Events For')).toBeHidden();
  // Delete My Shared Data is the app's quiet destructive button: red words, no fill.
  const forget = section.getByRole('button', { name: 'Delete My Shared Data' });
  await expect(forget).toHaveClass(/\bquiet\b/);
  await expect(forget).toHaveClass(/\bdanger\b/);
  const danger = await forget.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--pm-danger)';
    element.parentElement!.append(probe);
    const red = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(element).color, red];
  });
  expect(danger[0]).toBe(danger[1]);
  await expect(section.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
    'href',
    'https://penmoss.app/privacy/',
  );
  await holdForProof(page);

  // View Analytics Data: its own page, under Privacy in the nav.
  await section.getByRole('link', { name: /View Analytics Data/ }).click();
  await expect(page).toHaveURL(/\/settings\/privacy\/data$/);
  await expect(mac.getByTestId('settings-privacy-data-entry')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(privacy).not.toHaveAttribute('aria-current');
  const data = page.getByTestId('analytics-data');
  await expect(data.getByRole('heading', { level: 1 })).toHaveText('Analytics Data');
  await expect(data.getByTestId('settings-intro')).toHaveText(
    /^On this Mac, kept 7 days\. ID [0-9a-f]{8}…[0-9a-f]{4}\. Sharing since \d+ \w+ \d{4}\.$/,
  );
  // The counts by state, under the summary, as the Privacy row says them.
  await expect(data.getByTestId('analytics-data-counts')).toHaveText(
    /^(Waiting to Send [\d,]+ · )?Sent [\d,]+/,
  );
  await expect(data.getByRole('columnheader')).toHaveText([
    'Time',
    'Client',
    'Kind',
    'Name',
    'Props',
    'State',
  ]);
  const rows = data.getByTestId('analytics-data-row');
  const showing = data.getByTestId('analytics-data-showing');
  await expect(rows).toHaveCount(100);
  await expect(showing).toHaveText(/^Showing 1–100 of [\d,]+$/);
  await expect(data.getByTestId('analytics-data-later')).toBeDisabled();

  // Sent only: every row says so; Earlier and Later page through them.
  await data.getByTestId('analytics-data-state').getByText('Sent', { exact: true }).click();
  await expect(rows.locator('td:nth-child(6)')).toHaveText(Array(100).fill('Sent'));
  // Each state a tinted chip: sent green, waiting amber, the rest neutral.
  await expect(rows.first().locator('.chip.privacy-state')).toHaveAttribute('data-state', 'sent');
  await expect(showing).toHaveText(/^Showing 1–100 of [\d,]+$/);
  await data.getByTestId('analytics-data-earlier').click();
  await expect(showing).toHaveText(/^Showing 101–[\d,]+ of [\d,]+$/);
  await expect(rows.locator('td:nth-child(6)').first()).toHaveText('Sent');
  await expect(data.getByTestId('analytics-data-later')).toBeEnabled();
  await data.getByTestId('analytics-data-later').click();
  await expect(showing).toHaveText(/^Showing 1–100 of [\d,]+$/);
  await expect(data.getByTestId('analytics-data-later')).toBeDisabled();

  // By client: this Mac's own are App; nothing here is the CLI's.
  await data.getByTestId('analytics-data-client').getByText('App', { exact: true }).click();
  await expect(rows.locator('td:nth-child(2)')).toHaveText(Array(100).fill('App'));
  await data.getByTestId('analytics-data-client').getByText('CLI', { exact: true }).click();
  await expect(data.getByTestId('analytics-data-empty')).toBeVisible();
  await data.getByTestId('analytics-data-client').getByText('All', { exact: true }).click();
  await data.getByTestId('analytics-data-state').getByText('All', { exact: true }).click();
  await expect(rows).toHaveCount(100);

  // Copy as JSON: the exact body of the last batch sent.
  await data.getByRole('button', { name: 'Copy as JSON' }).click();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toMatch(/^\{"v":1,"install":"[0-9a-f]{32}","events":\[/);
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(fake.bodies).toContain(copied);
  // Ends on the summary, the counts under it and the chips.
  await data.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await holdForProof(page);

  // Off keeps what waits on this Mac (AC16): the endpoint is down, so events wait to be sent.
  fake.down = true;
  await seedEvents(page, 5);
  await sendNow(app);
  await expect.poll(async () => (await analyticsStatus(page)).counts.waiting).toBeGreaterThan(0);
  const before = (await analyticsStatus(page)).counts;
  await mac.getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/privacy$/);
  await expect(share).toBeChecked();
  await share.click();
  await expect(share).not.toBeChecked();
  await expect.poll(async () => (await analyticsStatus(page)).consent).toBe('no');
  const after = (await analyticsStatus(page)).counts;
  expect(after.waiting).toBe(0);
  expect(after.local).toBeGreaterThanOrEqual(before.local + before.waiting);
  const counts = section.getByTestId('privacy-counts');
  await expect(counts).not.toContainText('Waiting to Send');
  await expect(counts).toContainText(/Not Shared [\d,]+/);
  // Nothing more leaves: the endpoint is up again, and still nothing is sent.
  fake.down = false;
  const taken = fake.events().length;
  await sendNow(app);
  await page.waitForTimeout(1_000);
  expect(fake.events().length).toBe(taken);
  await counts.scrollIntoViewIfNeeded();
  await holdForProof(page);
});

test('Delete My Shared Data asks first, naming the ID; only Delete forgets it (ac37)', async () => {
  test.setTimeout(150_000);
  const { app, page, fake } = await sharing();
  await go(page, '/settings/privacy');
  const row = page.locator('[data-setting="analytics-id"]');
  const install = (await analyticsStatus(page)).install;
  const id = `${install.slice(0, 8)}…${install.slice(-4)}`;
  await expect(row.getByTestId('privacy-id')).toHaveText(id);
  const button = row.getByRole('button', { name: 'Delete My Shared Data' });
  const confirm = row.getByRole('alertdialog', { name: 'Delete Your Shared Data?' });

  // Under the button, naming the ID; focus on Cancel; Escape cancels.
  await button.click();
  await expect(confirm).toBeVisible();
  await expect(confirm.locator('.confirm-block-title')).toHaveText('Delete Your Shared Data?');
  await expect(confirm).toContainText(
    `Penmoss’s server deletes everything this Mac shared under ID ${id}, and this Mac gets a new ID. The record on this Mac stays.`,
  );
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(confirm.getByRole('button', { name: 'Delete' })).toHaveClass(/danger/);
  // Inside the group, inset from its edges as main's other confirmations are.
  const group = (await page
    .getByTestId('privacy-settings')
    .locator('.lf-group')
    .first()
    .boundingBox())!;
  const box = (await confirm.boundingBox())!;
  const remove = (await confirm.getByRole('button', { name: 'Delete' }).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(group.x);
  expect(box.x + box.width).toBeLessThanOrEqual(group.x + group.width - 1);
  expect(remove.x + remove.width).toBeLessThan(group.x + group.width - 4);
  await page.mouse.move(0, 0);
  await holdForProof(page);
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  // Cancel changes nothing either.
  await button.click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect(fake.forgets).toEqual([]);
  expect((await analyticsStatus(page)).install).toBe(install);

  // Delete: the endpoint forgets this ID, and this Mac takes a new one.
  await button.click();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(row.getByTestId('privacy-id-note')).toHaveText(
    'Your shared data was deleted, and this Mac has a new ID.',
  );
  expect(fake.forgets).toEqual([install]);
  await expect(row.getByTestId('privacy-id')).not.toHaveText(id);
  const fresh = (await analyticsStatus(page)).install;
  expect(fresh).toMatch(/^[0-9a-f]{32}$/);
  expect(fresh).not.toBe(install);
  // Sharing goes on, under the new ID: what is recorded from now on is sent with it.
  await expect(page.getByRole('switch', { name: 'Share Usage Data' })).toBeChecked();
  await seedEvents(page, 2);
  await expect
    .poll(
      async () => {
        await sendNow(app);
        return fake.batches.at(-1)?.install;
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    )
    .toBe(fresh);
  await row.scrollIntoViewIfNeeded();
  await holdForProof(page);
});
