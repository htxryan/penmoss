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

test.describe('with a notebook', () => {
  test.use({
    macWindow: true,
    seed: {
      name: 'Personal',
      folders: ['Assistant Memory', 'Penmoss'],
      notes: [{ title: 'Alpha', markdown: 'The first note.\n' }],
    },
  });

  const tree = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' }).first();

  test('6: with no note open, the empty home drags the window; the sidebar and its menus do not', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(tree(page)).toBeVisible({ timeout: 30_000 });
    await compact(page);
    await expect(page.getByTestId('empty-state')).toBeVisible();
    const home = await box(page, '.home');
    const sidebar = await box(page, '.sidebar');
    // The whole pane beside the sidebar, its middle and its corners.
    expect(home.height).toBeGreaterThan(700);
    for (const [x, y] of [
      [home.x + home.width / 2, home.y + home.height / 2],
      [home.x + 4, home.y + home.height - 4],
      [home.x + home.width - 4, home.y + 4],
    ] as const) {
      expect(await regionAt(page, x, y), `${x}, ${y}`).toBe('drag');
    }
    // The words of the empty state drag too (they are not text to select, finding 7).
    const words = await box(page, '[data-testid="empty-state"] p');
    expect(await regionAt(page, words.x + words.width / 2, words.y + 4)).toBe('drag');
    // The sidebar's resize strip keeps its 4 px over the pane (A1147), and the sidebar is not
    // the home's.
    const edge = await box(page, '[data-testid="sidebar-resizer"]');
    expect(await regionAt(page, edge.x + edge.width - 1, 400)).toBe('no-drag');
    expect(await regionAt(page, sidebar.x + 40, 400)).toBe('no-drag');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/window-6-home.png` });

    // A sidebar menu open over the home: the home stops dragging, so its items click.
    const folder = tree(page).getByRole('treeitem', { name: 'Assistant Memory', exact: true });
    await folder.click({ button: 'right', position: { x: sidebar.width - 30, y: 10 } });
    const menu = page.getByRole('menu', { name: 'Folder Assistant Memory' });
    await expect(menu).toBeVisible();
    const over = (await menu.boundingBox())!;
    expect(over.x + over.width).toBeGreaterThan(home.x);
    expect(await regionAt(page, over.x + over.width - 8, over.y + over.height / 2)).toBe('no-drag');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    expect(await regionAt(page, home.x + home.width / 2, home.y + home.height / 2)).toBe('drag');

    // A note open: the note's own pane is not the home, and does not drag.
    await tree(page).getByRole('treeitem', { name: 'Alpha', exact: true }).click();
    await expect(page.getByTestId('note-title')).toHaveValue('Alpha');
    await expect(page.locator('.home')).toHaveCount(0);
    const scroll = await box(page, '[data-testid="note-scroll"]');
    expect(
      await regionAt(page, scroll.x + scroll.width / 2, scroll.y + scroll.height / 2),
    ).not.toBe('drag');
    expect(errors).toEqual([]);
  });

  test('6: a narrow window’s open drawer stops the home dragging', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto('/');
    await compact(page);
    await expect(page.getByTestId('app-bar')).toBeVisible({ timeout: 30_000 });
    const home = await box(page, '.home');
    expect(await regionAt(page, home.x + home.width - 20, home.y + home.height / 2)).toBe('drag');
    await page.getByTestId('app-bar').getByRole('button', { name: 'Open Navigation' }).click();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-drawer', 'open');
    expect(await regionAt(page, home.x + home.width - 20, home.y + home.height / 2)).toBe(
      'no-drag',
    );
  });
});
