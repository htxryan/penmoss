import { expect, test } from '@playwright/test';
import { analyticsStatus, recordTotal, seedEvents } from './fake-analytics';
import {
  gitNotebook,
  go,
  holdForProof,
  launch,
  mainBounds,
  removeDataDirs,
  type Launched,
} from './support';

// PEN-137 in the Mac app: Settings → Privacy → Advanced, how much Penmoss keeps on this Mac.
// It opens in place, closed until then, with every limit under Usage Record, Logs and Bug
// Reports, each with its unit and range, how much each group may take, and Reset to Defaults
// at the foot (ac25). A value out of range is refused with its range, and not saved; a lowering
// that deletes nothing saves at once, and Reset to Defaults puts it back (ac27). Lowering Keep at
// Most below the record's size asks first, under the field, how many events go: Cancel and
// Escape put the old value back, Delete saves it and deletes them from the record now (ac39).
// The web suite has the same steps against a stand-in bridge (apps/web/test/e2e/analytics.spec.ts).

const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

test('Advanced opens in place; a limit out of range is refused, a lowering that deletes asks first (ac25, ac27, ac39)', async () => {
  test.setTimeout(180_000);
  const launched = await launch();
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  await gitNotebook(launched);
  // A record well past Keep at Most's least (500).
  await seedEvents(page, 700);
  await expect.poll(() => recordTotal(page)).toBeGreaterThanOrEqual(700);

  await go(page, '/settings/privacy');
  const section = page.getByTestId('privacy-settings');
  const advanced = section.getByTestId('privacy-advanced');
  await expect(advanced).not.toHaveAttribute('open');
  await section.getByTestId('privacy-advanced-summary').click();
  await expect(page).toHaveURL(/\/settings\/privacy$/);
  await expect(advanced).toHaveAttribute('open', '');
  await expect(advanced).toContainText(
    'How much Penmoss keeps on this Mac. Lowering a limit asks first, then deletes what falls outside it.',
  );
  await expect(advanced.locator('.privacy-limit-group-title')).toHaveText([
    'Usage Record',
    'Logs',
    'Bug Reports',
  ]);
  await expect(advanced.locator('.privacy-limit-label')).toHaveText([
    'Keep Events For',
    'Keep at Most',
    'Log File Size',
    'Log Files Kept',
    'Keep Log Lines For',
    'Attach Logs from the Last',
    'At Most',
    'At Most',
  ]);
  const days = advanced.locator('[data-setting="keep-events-for"]');
  const daysField = days.getByRole('textbox');
  await expect(daysField).toHaveValue('7');
  await expect(days.getByTestId('privacy-limit-range')).toHaveText('1–360 days');
  await expect(days.getByTestId('privacy-limit-default')).toHaveCount(0);
  const most = advanced.locator('[data-setting="keep-at-most"]');
  const mostField = most.getByRole('textbox');
  await expect(mostField).toHaveValue('200,000');
  await expect(most.getByTestId('privacy-limit-range')).toHaveText('500–2,000,000 events');
  // How much each group may take, and Reset to Defaults at the foot.
  await expect(advanced.getByTestId('privacy-space-usage')).toHaveText(
    'About 95 MB of events at most on this Mac',
  );
  await expect(advanced.getByTestId('privacy-space-logs')).toHaveText(
    'Up to 2 MB of logs on this Mac (at most 400 MB)',
  );
  await expect(advanced.getByTestId('privacy-space-report')).toHaveText(
    'A bug report attaches the last 24 hours, at most 300 lines and 16 KB.',
  );
  await expect(advanced.getByTestId('privacy-limits-reset')).toBeDisabled();
  await expect(advanced.getByTestId('privacy-limits-foot')).toContainText(
    'Or run penmoss analytics limits in a terminal.',
  );
  await advanced.scrollIntoViewIfNeeded();
  await holdForProof(page);

  // Out of range: said, not saved.
  await daysField.fill('400');
  await daysField.press('Enter');
  await expect(days.getByRole('alert')).toHaveText('Between 1 and 360');
  expect((await analyticsStatus(page)).limits['events.days']).toBe(7);

  // Lower, deleting nothing (every event is from today): saved without asking.
  await daysField.fill('3');
  await daysField.press('Enter');
  await expect(days.getByTestId('privacy-limit-default')).toHaveText('Default: 7');
  await expect(advanced.getByRole('alertdialog')).toHaveCount(0);
  await expect.poll(async () => (await analyticsStatus(page)).limits['events.days']).toBe(3);
  // Reset to Defaults puts it back (raising deletes nothing, so it doesn't ask).
  await advanced.getByTestId('privacy-limits-reset').click();
  await expect(daysField).toHaveValue('7');
  await expect(days.getByTestId('privacy-limit-default')).toHaveCount(0);
  await expect.poll(async () => (await analyticsStatus(page)).limits['events.days']).toBe(7);

  // Keep at Most below the record's size asks first, under the field, how many events go.
  const total = await recordTotal(page);
  const confirm = most.getByRole('alertdialog', { name: /^Delete [\d,]+ Events\?$/ });
  const ask = async () => {
    await mostField.fill('500');
    await mostField.press('Enter');
    await expect(confirm).toBeVisible();
  };
  await ask();
  const title = (await confirm.locator('.confirm-block-title').textContent()) ?? '';
  const count = Number(/^Delete ([\d,]+) Events\?$/.exec(title)![1]!.replaceAll(',', ''));
  expect(count).toBeGreaterThanOrEqual(total - 500);
  await expect(confirm).toHaveAccessibleName(title);
  await expect(confirm).toContainText(
    'They’re beyond the newest 500. They’re deleted from this Mac now, and raising the limit later won’t bring them back.',
  );
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(confirm.getByRole('button', { name: 'Delete' })).toHaveClass(/danger/);
  await confirm.scrollIntoViewIfNeeded();
  await holdForProof(page);
  // Cancel puts the old value back; nothing is deleted.
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(mostField).toHaveValue('200,000');
  expect((await analyticsStatus(page)).limits['events.max']).toBe(200_000);
  expect(await recordTotal(page)).toBeGreaterThanOrEqual(total);
  // Escape cancels too.
  await ask();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(mostField).toHaveValue('200,000');
  expect((await analyticsStatus(page)).limits['events.max']).toBe(200_000);

  // Delete saves it, and the record keeps only the newest 500.
  await ask();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(mostField).toHaveValue('500');
  await expect(most.getByTestId('privacy-limit-default')).toHaveText('Default: 200,000');
  await expect.poll(async () => (await analyticsStatus(page)).limits['events.max']).toBe(500);
  // What this page records meanwhile (clicks, the setting) joins after the prune.
  await expect.poll(() => recordTotal(page)).toBeLessThanOrEqual(520);
  // 500 events of about 500 bytes each (core's EVENT_BYTES).
  await expect(advanced.getByTestId('privacy-space-usage')).toHaveText(
    'About 244 KB of events at most on this Mac',
  );
  await most.scrollIntoViewIfNeeded();
  await holdForProof(page);
});
