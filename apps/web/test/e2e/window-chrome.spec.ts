import { expect, test, type Page } from './fixtures';

// Ryan's review of #192 (14 Nov 2026), the window and its chrome, in the web app with the Mac
// app's window (`macWindow`: the compact title bar): the first run's window drags by a strip
// across its top (finding 1).

const SHOTS = process.env['PENMOSS_EVIDENCE'];
/** The first row, where the traffic lights are (`--pm-titlebar-row`). */
const TITLE_BAR_ROW = 48;

/**
 * The region Electron gives a point (A723, A1123): of the elements with one there, the last in
 * the DOM wins, as later regions are applied over earlier ones, and a scroll box's clip is not
 * taken into account.
 */
const regionAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      let won = 'none';
      for (const element of document.querySelectorAll<HTMLElement>('body *')) {
        const style = getComputedStyle(element);
        const value = style.getPropertyValue('-webkit-app-region');
        if (value !== 'drag' && value !== 'no-drag') continue;
        if (style.visibility !== 'visible') continue;
        const at = element.getBoundingClientRect();
        if (px >= at.left && px < at.right && py >= at.top && py < at.bottom) won = value;
      }
      return won;
    },
    [x, y] as const,
  );

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  expect(found, selector).not.toBeNull();
  return found!;
};

const compact = (page: Page) =>
  expect(page.locator('html')).toHaveAttribute('data-titlebar', 'compact');

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.describe('with no notebook', () => {
  test.use({ macWindow: true, seed: null });

  test('1: the first run drags the window by a strip across its top; its controls click', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 900, height: 420 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome to Penmoss' })).toBeVisible();
    await compact(page);
    // The strip: the window's width, the lights' row, at its top, and it drags.
    const strip = await box(page, '[data-testid="window-drag"]');
    expect(strip).toEqual({ x: 0, y: 0, width: 900, height: TITLE_BAR_ROW });
    expect(await regionAt(page, 450, TITLE_BAR_ROW / 2)).toBe('drag');
    expect(await regionAt(page, 20, 10)).toBe('drag');
    // The screen starts below it, and its buttons still take a click.
    const welcome = await box(page, '[data-testid="first-run"]');
    expect(welcome.y).toBeGreaterThanOrEqual(TITLE_BAR_ROW);
    const choice = await box(page, '[data-testid="first-run-new"]');
    expect(await regionAt(page, choice.x + 10, choice.y + 10)).not.toBe('drag');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/window-1-first-run.png` });

    // Scrolled, the screen goes under the strip, which still drags: its controls set no region
    // of their own, so none takes the strip from it (PEN-65's trap).
    await page.getByTestId('first-run-existing').click();
    await expect(page.getByTestId('git-add')).toBeVisible();
    const scrolled = await page
      .locator('.window-bare')
      .evaluate((element) => ((element.scrollTop = 120), element.scrollTop));
    expect(scrolled).toBeGreaterThan(0);
    for (const x of [20, 200, 450, 700]) {
      expect(await regionAt(page, x, TITLE_BAR_ROW / 2), `x ${x}`).toBe('drag');
    }
    await page.getByTestId('first-run-back').click();
    await expect(page.getByRole('heading', { name: 'Welcome to Penmoss' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
