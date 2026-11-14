import { expect, test, type Page } from './fixtures';

// PEN-65 (Ryan's "Penmoss Feedback (LATEST)", item 3): Settings' bar stopped moving the Mac
// window, and leaving Settings and coming back fixed it. Settings' sections scroll under the bar,
// Electron counts a control scrolled out of its box as where it would be, and the controls'
// `no-drag`, later in the DOM, won over the bar's `drag`. Leaving reset the scroll.

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

test('PEN-65: Settings’ bar still drags the Mac window once its sections scroll', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 500 });
  await page.goto('/settings/appearance');
  // The Mac app's compact title bar, as mac-window.ts sets it.
  await page.evaluate(() => (document.documentElement.dataset['titlebar'] = 'compact'));
  const bar = await box(page, '.settings-bar');
  const control = page.locator('.settings-content select').first();
  await expect(control).toBeVisible();
  const before = (await control.boundingBox())!;
  // The bar's empty part, over the column the control is in.
  const point = { x: before.x + before.width / 2, y: bar.y + bar.height / 2 };
  expect(await regionAt(page, point.x, point.y)).toBe('drag');

  // Scroll the control up under the bar, as reading down to it does.
  const scroller = page.locator('.settings-content');
  const scrolled = await scroller.evaluate(
    (element, by) => {
      element.scrollTop += by;
      return element.scrollTop;
    },
    Math.ceil(before.y - point.y) + 4,
  );
  expect(scrolled).toBeGreaterThan(0);
  expect(await box(page, '.settings-bar')).toEqual(bar);
  const under = (await control.boundingBox())!;
  expect(under.y).toBeLessThanOrEqual(point.y);
  expect(under.y + under.height).toBeGreaterThan(point.y);
  expect(await regionAt(page, point.x, point.y)).toBe('drag');
  // The bar's own buttons still take a click.
  const back = await box(page, '.settings-bar button');
  expect(await regionAt(page, back.x + back.width / 2, point.y)).toBe('no-drag');
});
