import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectErrors, gitNotebook, go, launch, removeDataDirs, type Launched } from './support';

// PEN-70 (A1247) in the Mac app: tooltips wait 1 second by default; Settings → Display → Show
// Tooltips After chooses 0.5, 1, 1.5 or 2 seconds, or Never on hover, and the next hover uses
// it with no reload. Keyboard focus still shows a tooltip at once.

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

/**
 * How long, in ms, from the pointer reaching `target` to its tooltip showing, by the page's own
 * clock (a slow machine cannot make a late tooltip look early).
 */
async function tipDelay(page: Page, target: Locator): Promise<number> {
  await page.mouse.move(900, 700);
  await expect(page.getByTestId('tooltip')).toBeHidden();
  await target.evaluate((element) => {
    const times = { over: 0, shown: 0 };
    (window as unknown as { tipTimes: typeof times }).tipTimes = times;
    element.addEventListener('pointerover', () => (times.over ||= performance.now()), {
      once: true,
    });
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="tooltip"]') && !times.shown) {
        times.shown = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await target.hover();
  await expect(page.getByTestId('tooltip')).toBeVisible();
  const times = await page.evaluate(
    () => (window as unknown as { tipTimes: { over: number; shown: number } }).tipTimes,
  );
  expect(times.over).toBeGreaterThan(0);
  return times.shown - times.over;
}

test('Show Tooltips After in Settings → Display sets the hover delay; Never stops it; focus shows at once', async () => {
  const launched = await launch({ macWindow: true });
  opened.push(launched);
  const { page } = launched;
  const errors = collectErrors(page, false);
  await gitNotebook(launched);
  await go(page, '/settings/display');
  const field = page.getByLabel('Show Tooltips After');
  const tooltip = page.getByTestId('tooltip');
  const back = page.locator('.back-link');

  await expect(field).toBeEnabled();
  await expect(field.locator('option')).toHaveText([
    '0.5 Seconds',
    '1 Second (Default)',
    '1.5 Seconds',
    '2 Seconds',
    'Never',
  ]);
  await expect(field).toHaveValue('1000');
  await expect(page.getByTestId('tooltip-delay-help')).toHaveText(
    'How long the pointer rests on a button before its name shows. Tabbing to a button shows it at once. Changes sync to your other devices.',
  );
  if (SHOTS) {
    await field.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/mac-tooltip-delay-field.png` });
  }

  // Unset: a second.
  expect(await tipDelay(page, back)).toBeGreaterThanOrEqual(995);
  await expect(tooltip).toHaveText('Back to Your Notes');

  // 2 Seconds: the next hover waits two, with no reload.
  await page.mouse.move(900, 700);
  await field.selectOption({ label: '2 Seconds' });
  expect(await tipDelay(page, back)).toBeGreaterThanOrEqual(1995);

  // Never: no tooltip on hover.
  await page.mouse.move(900, 700);
  await field.selectOption({ label: 'Never' });
  await back.hover();
  await page.waitForTimeout(2500);
  await expect(tooltip).toBeHidden();

  // Keyboard focus still shows it at once.
  await page.mouse.move(900, 700);
  await back.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(back).toBeFocused();
  await expect(tooltip).toHaveText('Back to Your Notes', { timeout: 500 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mac-tooltip-delay-focus.png` });
  await page.keyboard.press('Escape');

  await field.selectOption({ label: '1 Second (Default)' });
  await expect(field).toHaveValue('1000');
  expect(errors).toEqual([]);
});
