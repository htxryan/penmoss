import { expect, test, type Locator, type Page } from './fixtures';
import { storedSetting } from './stored';

// PEN-70 (A1247), in the web app (the Mac app runs the same page): tooltips wait 1 second by
// default, and Settings → Display → Show Tooltips After chooses 0.5, 1, 1.5 or 2 seconds, or
// Never on hover. Keyboard focus still shows a tooltip at once. A change applies to the next
// hover, with no reload, and is stored as the synced `tooltip.delay`.

const SHOTS = process.env['PENMOSS_EVIDENCE'];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/**
 * How long, in ms, from the pointer reaching `target` to its tooltip showing, as the page's own
 * clock measures it (so a slow test machine cannot make a late tooltip look early).
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

test('Show Tooltips After sets how long a hover waits, Never stops it, focus shows at once', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/settings/display');
  const field = page.getByLabel('Show Tooltips After');
  const tooltip = page.getByTestId('tooltip');
  const back = page.locator('.back-link');

  // AC3: after the title bar's buttons, every choice, 1 Second (Default) when unset.
  await expect(field).toBeEnabled();
  await expect(field.locator('option')).toHaveText([
    '0.5 Seconds',
    '1 Second (Default)',
    '1.5 Seconds',
    '2 Seconds',
    'Never',
  ]);
  await expect(field).toHaveValue('1000');
  const order = await page
    .getByTestId('display-settings')
    .evaluate((section) =>
      [
        ...section.querySelectorAll(
          '[data-testid="note-bar-settings"], [data-testid="tooltip-delay"]',
        ),
      ].map((each) => each.getAttribute('data-testid')),
    );
  expect(order).toEqual(['note-bar-settings', 'tooltip-delay']);
  if (SHOTS) {
    await field.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/tooltip-delay-field.png` });
  }

  // AC1: unset, a tooltip waits a second.
  expect(await tipDelay(page, back)).toBeGreaterThanOrEqual(995);
  await expect(tooltip).toHaveText('Back to Your Notes');

  // AC4: 2 Seconds applies to the next hover, with no reload, and is stored to sync.
  await page.mouse.move(900, 700);
  await field.selectOption({ label: '2 Seconds' });
  await expect.poll(() => storedSetting(page, 'tooltip.delay')).toBe(2000);
  // Measured by the page's clock: nothing at 1.5 s, the tooltip at 2 s.
  expect(await tipDelay(page, back)).toBeGreaterThanOrEqual(1995);
  await expect(tooltip).toHaveText('Back to Your Notes');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tooltip-delay-2s.png` });

  // 0.5 Seconds: sooner.
  await page.mouse.move(900, 700);
  await field.selectOption({ label: '0.5 Seconds' });
  const half = await tipDelay(page, back);
  expect(half).toBeGreaterThanOrEqual(495);
  expect(half).toBeLessThan(1000);

  // AC5: Never shows no tooltip on hover, however long the pointer rests.
  await page.mouse.move(900, 700);
  await field.selectOption({ label: 'Never' });
  await expect.poll(() => storedSetting(page, 'tooltip.delay')).toBe('never');
  await back.hover();
  await page.waitForTimeout(2500);
  await expect(tooltip).toBeHidden();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tooltip-delay-never.png` });

  // AC6: keyboard focus still shows it at once.
  await page.mouse.move(900, 700);
  await back.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(back).toBeFocused();
  await expect(tooltip).toHaveText('Back to Your Notes', { timeout: 500 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tooltip-delay-focus.png` });
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();

  // Back to the default: 1 Second (Default) is chosen again.
  await field.selectOption({ label: '1 Second (Default)' });
  await expect(field).toHaveValue('1000');
  expect(errors).toEqual([]);
});
