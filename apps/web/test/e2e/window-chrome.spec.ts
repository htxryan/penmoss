import { expect, type Page, test } from './fixtures';
import { collectErrors, ULID } from './support/app';

// Ryan's review of #192 (14 Nov 2026), the window and its chrome, in the web app with the Mac
// app's window (`macWindow`: the compact title bar): the first run's window drags by a strip
// across its top (finding 1); with no note open the empty home drags it (6); interface text is
// not selectable and keeps the arrow, content is (7); at the narrowest sidebar a notebook's
// chevron shows and ⋯ holds its other buttons (19); a folder's + sits flush (20). The rail's
// order (18) is in sidebar-pen-135.spec.ts.

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
    const choice = await box(page, '[data-testid="first-run-start"]');
    expect(await regionAt(page, choice.x + 10, choice.y + 10)).not.toBe('drag');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/window-1-first-run.png` });

    // Scrolled, the screen goes under the strip, which still drags: its controls set no region
    // of their own, so none takes the strip from it (PEN-65's trap). Pick Repository (three
    // choices) is taller than this window.
    await page.getByTestId('first-run-start').click();
    await page.getByTestId('first-run-continue').click();
    await expect(page.getByRole('heading', { name: 'Pick Repository' })).toBeVisible();
    const scrolled = await page
      .locator('.window-bare')
      .evaluate((element) => ((element.scrollTop = 120), element.scrollTop));
    expect(scrolled).toBeGreaterThan(0);
    for (const x of [20, 200, 450, 700]) {
      expect(await regionAt(page, x, TITLE_BAR_ROW / 2), `x ${x}`).toBe('drag');
    }
    await page.getByTestId('first-run-back').click();
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

  test('7: interface text is not selectable and keeps the arrow; a note’s text and fields are', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(tree(page)).toBeVisible({ timeout: 30_000 });
    const selected = () => page.evaluate(() => getSelection()?.toString() ?? '');
    const cursor = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((element) => getComputedStyle(element).cursor);
    /** Drags across `selector`'s text, from its start to its end, and returns what that selects. */
    const dragAcross = async (selector: string) => {
      await page.evaluate(() => getSelection()?.removeAllRanges());
      const at = await box(page, selector);
      await page.mouse.move(at.x + 2, at.y + at.height / 2);
      await page.mouse.down();
      await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2, { steps: 4 });
      await page.mouse.move(at.x + at.width - 2, at.y + at.height / 2, { steps: 4 });
      await page.mouse.up();
      return selected();
    };

    // The empty state's words (Ryan's screenshot): a drag selects nothing, the arrow over them.
    expect(await dragAcross('[data-testid="empty-state"] p')).toBe('');
    expect(await cursor('[data-testid="empty-state"] p')).toBe('default');
    expect(await cursor('[data-testid="empty-state"] h2')).toBe('default');
    // Nor the sidebar's names, or a double-click on a word there.
    await page.locator('.sb-section-name').first().dblclick();
    expect(await selected()).toBe('');
    expect(await cursor('.sb-section-name')).not.toBe('text');

    // A note: its title and its text select, with the text cursor.
    await tree(page).getByRole('treeitem', { name: 'Alpha', exact: true }).click();
    await expect(page.getByTestId('note-title')).toHaveValue('Alpha');
    const text = '[data-testid="note-body"] .ProseMirror p';
    await expect(page.locator(text)).toHaveText('The first note.');
    expect(await dragAcross(text)).toContain('first note');
    expect(await cursor(text)).toBe('auto');
    expect(await cursor('[data-testid="note-title"]')).toBe('auto');
    await page.getByTestId('note-title').selectText();
    expect(
      await page
        .getByTestId('note-title')
        .evaluate((field: HTMLTextAreaElement) =>
          field.value.slice(field.selectionStart, field.selectionEnd),
        ),
    ).toBe('Alpha');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/window-7-note.png` });

    // A notebook's facts in Settings (its repository's address) select too; their labels do not.
    await page.goto('/settings/git-notebooks');
    await page.getByTestId('git-notebook-row').first().click();
    await expect(page.getByTestId('git-repository')).toBeVisible();
    expect(await cursor('[data-setting="repository"] .lf-row-label')).toBe('default');
    await page.getByTestId('git-repository').dblclick({ position: { x: 4, y: 6 } });
    expect(await selected()).not.toBe('');
    expect(errors).toEqual([]);
  });

  /** The notebook's row in the sidebar (its section's head). */
  const notebookRow = (page: Page) => page.locator('.sb-source > .sb-section-head').first();

  test('19: a notebook’s row is New Note, New Folder and ⋯ at any width; ⋯ is the right-click menu with Rename…, Sort Order…, Time Machine and Trash', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(tree(page).getByRole('treeitem', { name: 'Penmoss', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const row = notebookRow(page);
    const actions = row.getByTestId('tree-actions');
    const more = row.getByTestId('notebook-more');
    /** The row's buttons, in order (R2-21: the same at every width; A1392's fold is gone). */
    const buttons = async () => {
      await row.hover();
      await expect(more).toBeVisible();
      return actions
        .locator(':scope > :is(button, a)')
        .evaluateAll((all) => all.map((each) => each.getAttribute('aria-label')));
    };
    const ROW = ['New Note in This Notebook', 'New Folder', 'More Notebook Actions'];
    expect(await buttons()).toEqual(ROW);
    await expect(row.getByTestId('section-sync')).toBeVisible();

    // The narrowest: the same buttons.
    const edge = page.getByTestId('sidebar-resizer');
    await edge.focus();
    await page.keyboard.press('Home');
    await expect(edge).toHaveAttribute('aria-valuenow', '14.5');
    expect(await buttons()).toEqual(ROW);
    // The notebook's chevron keeps its 12 px, and its name has room to be read.
    const chevron = (await row.locator('.sb-section-toggle > .i').boundingBox())!;
    expect(chevron.width).toBeCloseTo(12, 0);
    expect(chevron.height).toBeCloseTo(12, 0);
    const name = (await row.locator('.sb-section-name').boundingBox())!;
    expect(name.x).toBeGreaterThanOrEqual(chevron.x + chevron.width);
    expect(name.width).toBeGreaterThanOrEqual(56);
    await expect(row.getByTestId('section-sync')).toBeVisible();
    // Every folder's chevron has its size too.
    for (const twisty of await tree(page).locator('.folder-row > .twisty').all()) {
      const at = (await twisty.boundingBox())!;
      expect(at.width).toBeGreaterThan(10);
      expect(at.height).toBeGreaterThan(10);
    }
    if (SHOTS) await page.locator('.sidebar').screenshot({ path: `${SHOTS}/window-19-narrow.png` });

    // ⋯ holds the rest, each with its icon (R2-20, R2-21).
    await more.click();
    const menu = page.getByRole('menu', { name: 'More Notebook Actions' });
    const items = menu.getByRole('menuitem');
    await expect(items).toHaveText(['Rename…', 'Sort Order…', 'Time Machine', 'Trash']);
    expect(
      await items.evaluateAll((all) =>
        all.map((each) => each.querySelector('[data-icon]')?.getAttribute('data-icon')),
      ),
    ).toEqual(['pencil', 'sort', 'history', 'trash']);
    // The sidebar's right-click menu's look: its surface, its items, and their hover.
    const look = async (target: typeof menu) => {
      const item = target.getByRole('menuitem').first();
      await item.hover();
      const surface = await target.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.backgroundColor, style.borderTopColor, style.boxShadow, style.padding];
      });
      const each = await item.evaluate((element) => {
        const style = getComputedStyle(element);
        const icon = element.querySelector('[data-icon]')!;
        return [
          style.backgroundColor,
          style.color,
          style.fontSize,
          style.minHeight,
          getComputedStyle(icon).color,
        ];
      });
      return [...surface, ...each];
    };
    const moreLook = await look(menu);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
    await tree(page)
      .getByRole('treeitem', { name: 'Penmoss', exact: true })
      .click({ button: 'right' });
    const folderMenu = page.getByTestId('context-menu');
    await expect(folderMenu).toBeVisible();
    expect(moreLook).toEqual(await look(folderMenu));
    await page.keyboard.press('Escape');

    // By keyboard: ↓ on ⋯ opens it, focus on its first item; ↓ moves; Sort Order… opens the
    // sort order under ⋯; Escape goes back to ⋯.
    await row.hover();
    await more.focus();
    await page.keyboard.press('ArrowDown');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Sort Order…' })).toBeFocused();
    await page.keyboard.press('Enter');
    const sort = page.getByRole('menu', { name: /^Sort Order for / });
    await expect(sort.getByRole('menuitemradio', { name: 'A–Z' })).toBeVisible();
    await sort.getByRole('menuitemradio', { name: 'A–Z' }).click();
    await expect(sort).toBeHidden();
    await more.click();
    await menu.getByRole('menuitem', { name: 'Sort Order…' }).click();
    await expect(sort.getByRole('menuitemradio', { name: 'A–Z' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await sort.getByRole('menuitemradio', { name: 'Manual' }).click();

    // Rename… edits the name in place, as the row's right-click does (A1383); Escape keeps it.
    const before = await row.locator('.sb-section-name').textContent();
    await row.hover();
    await more.click();
    await menu.getByRole('menuitem', { name: 'Rename…' }).click();
    const input = page.getByTestId('notebook-rename-input');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(before!);
    await input.press('Escape');
    await expect(row.locator('.sb-section-name')).toHaveText(before!);

    // Trash opens the notebook's Trash.
    await row.hover();
    await more.click();
    await menu.getByRole('menuitem', { name: 'Trash' }).click();
    await expect(page).toHaveURL(/\/trash\?source=/);
    expect(errors).toEqual([]);
  });

  test('20: a folder’s + sits flush at its row’s end, the row’s height, as a notebook’s buttons do', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const folder = tree(page).getByRole('treeitem', { name: 'Assistant Memory', exact: true });
    await expect(folder).toBeVisible({ timeout: 30_000 });
    for (const width of ['default', 'narrowest'] as const) {
      if (width === 'narrowest') {
        await page.getByTestId('sidebar-resizer').focus();
        await page.keyboard.press('Home');
      }
      await folder.hover();
      const plus = folder.getByTestId('folder-row-new-note');
      await expect(plus).toBeVisible();
      const row = (await folder.boundingBox())!;
      const at = (await plus.boundingBox())!;
      // No margin on any side: the row's full height, square, touching its right edge.
      expect(at.y, width).toBeCloseTo(row.y, 0);
      expect(at.height, width).toBeCloseTo(row.height, 0);
      expect(at.width, width).toBeCloseTo(at.height, 0);
      expect(at.x + at.width, width).toBeCloseTo(row.x + row.width, 0);
      const margin = await plus.evaluate((element) => getComputedStyle(element).margin);
      expect(margin, width).toBe('0px');
      // The same as the notebook's row's buttons: square, its full height, no margin.
      const head = notebookRow(page);
      await head.hover();
      const headBox = (await head.boundingBox())!;
      const newNote = (await head.getByTestId('notebook-new-note').boundingBox())!;
      expect(newNote.height, width).toBeCloseTo(headBox.height, 0);
      expect(newNote.width, width).toBeCloseTo(newNote.height, 0);
      // The section title rows' tools too (one shared class, `.row-end`).
      const section = page.getByTestId('sidebar-section-quickAccess');
      const title = section.locator('.sb-section-head').first();
      await title.hover();
      // Inside its borders: the row's padding box.
      const inner = await title.evaluate((element) => {
        const at = element.getBoundingClientRect();
        return {
          top: at.top + element.clientTop,
          height: element.clientHeight,
          right: at.left + element.clientLeft + element.clientWidth,
        };
      });
      const move = (await section.getByTestId('section-move').boundingBox())!;
      const hide = (await section.getByTestId('section-hide').boundingBox())!;
      expect(move.y, width).toBeCloseTo(inner.top, 0);
      expect(move.height, width).toBeCloseTo(inner.height, 0);
      expect(move.width, width).toBeCloseTo(move.height, 0);
      expect(hide.x, width).toBeCloseTo(move.x + move.width, 0);
      expect(hide.x + hide.width, width).toBeCloseTo(inner.right, 0);
    }
    await folder.hover();
    if (SHOTS) await folder.screenshot({ path: `${SHOTS}/window-20-folder-plus.png` });
    // Still New Note in that folder.
    await folder.getByTestId('folder-row-new-note').click();
    await expect(page).toHaveURL(/\/notes\/[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(errors).toEqual([]);
  });
});

const LONG = Array.from({ length: 80 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n\n');

const tree = (page: Page) =>
  page
    .getByTestId('source-section')
    .and(page.getByRole('region', { name: 'Quanta', exact: true }))
    .getByRole('tree', { name: 'Folders and notes' });

async function openNote(page: Page, title: string): Promise<void> {
  await tree(page).getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}
test.describe('in Quanta, with a folder and a long note', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Miscellaneous'],
      notes: [{ title: 'Josh Onboarding' }, { title: 'Long', markdown: `${LONG}\n` }],
    },
  });

  // T65, item 6.
  test('a scrolled note’s top bar still drags the Mac window by its empty part', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto('/');
    await openNote(page, 'Long');
    // The Mac app's compact title bar, as mac-window.ts sets it.
    await page.evaluate(() => (document.documentElement.dataset['titlebar'] = 'compact'));
    // The main window's top bar is its tab strip since PEN-140 (A1505): the note's tab where
    // the breadcrumb was, its buttons at the end.
    const bar = await box(page, '.tab-strip');
    const actions = await box(page, '.tab-strip-end .note-actions');
    const crumbs = await box(page, '.tab-strip [role="tab"][aria-selected="true"]');
    const add = await box(page, '.tab-strip [data-testid="tab-new"]');
    const text = await box(page, '.note-body');
    // Over the text's column, past the tab and + and short of the buttons: the bar's empty part,
    // where the title and the text pass under it.
    const empty = { x: text.x + text.width / 2, y: bar.y + bar.height / 2 };
    expect(empty.x).toBeGreaterThan(crumbs.x + crumbs.width);
    expect(empty.x).toBeGreaterThan(add.x + add.width);
    expect(empty.x).toBeLessThan(actions.x);
    // The tab is a control, which clicks (the breadcrumb's words dragged).
    const words = { x: crumbs.x + 4, y: empty.y };
    expect(await regionAt(page, empty.x, empty.y)).toBe('drag');

    // Scrolled: the title and the text go up under the bar, which still drags; its buttons click.
    // The text scrolls in its own column since A1132.
    const scroller = page.getByTestId('note-scroll');
    await scroller.evaluate((element) => (element.scrollTop = 900));
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(900);
    expect(await box(page, '.tab-strip')).toEqual(bar);
    const under = await box(page, '.note-body .ProseMirror');
    expect(under.y).toBeLessThan(bar.y);
    expect(under.x).toBeLessThan(empty.x);
    expect(under.x + under.width).toBeGreaterThan(empty.x);
    expect(await regionAt(page, empty.x, empty.y)).toBe('drag');
    expect(await regionAt(page, words.x, words.y)).toBe('no-drag');
    expect(await regionAt(page, actions.x + 10, empty.y)).toBe('no-drag');
    // The editor's own surfaces stay clickable over the bar: the selection toolbar is one.
    expect(
      await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.setAttribute('role', 'toolbar');
        const button = document.createElement('button');
        probe.append(button);
        document.querySelector('.note-columns')!.append(probe);
        const regions = [probe, button].map((element) =>
          getComputedStyle(element).getPropertyValue('-webkit-app-region'),
        );
        probe.remove();
        return regions;
      }),
    ).toEqual(['no-drag', 'no-drag']);
    expect(errors).toEqual([]);
  });
});

/** The traffic lights' room in a compact window (`--pm-titlebar-inset`, A722). */
const INSET = 88;

async function collapse(page: Page): Promise<void> {
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
}

async function expand(page: Page): Promise<void> {
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).not.toHaveAttribute('data-sidebar', 'collapsed');
}

async function chooseMode(page: Page, mode: 'Light' | 'Dark'): Promise<void> {
  await page.goto('/settings/appearance');
  await page.getByTestId('theme-mode').getByText(mode).click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', mode.toLowerCase());
  await page.goto('/');
  await expect(tree(page)).toBeVisible({ timeout: 30_000 });
}

/** The computed background colour of the first element `selector` matches. */
const background = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
test.describe('in the Mac window, in Quanta with two notes', () => {
  test.use({
    macWindow: true,
    seed: {
      name: 'Quanta',
      notes: [
        { title: 'Alpha', markdown: 'The first note.\n' },
        { title: 'Bravo', markdown: 'The second note.\n' },
      ],
    },
  });

  // PEN-135, item 6.
  test('beside the rail, Back, Forward and the pin start the note’s title bar, after the lights', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(tree(page)).toBeVisible({ timeout: 30_000 });
    await compact(page);
    await openNote(page, 'Alpha');
    await openNote(page, 'Bravo');
    // Open: in the sidebar's head.
    const head = page.locator('.sb-head');
    await expect(head.getByTestId('app-back')).toBeVisible();
    await expect(head.getByTestId('keep-on-top')).toBeVisible();

    await collapse(page);
    // At the tab strip's start since PEN-140 (A1505): the main window's first row.
    const lead = page.locator('.tab-strip > .tab-strip-lead');
    for (const id of ['app-back', 'app-forward', 'keep-on-top']) {
      await expect(lead.getByTestId(id), id).toBeVisible();
      await expect(page.locator('.sidebar').getByTestId(id), id).toHaveCount(0);
    }
    // The rail keeps the toggle, below the lights' row.
    const toggle = await box(page, '[data-testid="toggle-sidebar"]');
    expect(toggle.y).toBeGreaterThanOrEqual(48);
    // At the bar's start, after the lights' room, then the tabs.
    const back = await box(page, '.tab-strip [data-testid="app-back"]');
    const forward = await box(page, '.tab-strip [data-testid="app-forward"]');
    const pin = await box(page, '.tab-strip [data-testid="keep-on-top"]');
    const crumbs = await box(page, '.tab-strip .tab-list');
    const bar = await box(page, '.tab-strip');
    expect(back.x).toBeGreaterThanOrEqual(INSET);
    expect(back.x).toBeLessThan(INSET + 4);
    expect(forward.x).toBeGreaterThan(back.x);
    expect(pin.x).toBeGreaterThanOrEqual(forward.x + forward.width - 1);
    expect(crumbs.x).toBeGreaterThan(pin.x + pin.width);
    // As tall as the row, flush with it.
    for (const button of [back, forward, pin]) {
      expect(button.y).toBeCloseTo(bar.y, 0);
      expect(button.height).toBeCloseTo(bar.height - 1, 0);
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-6-compact.png` });
    // They work there: Back to Alpha, Forward to Bravo, the pin pins the window.
    await page.locator('.tab-strip').getByTestId('app-back').click();
    await expect(page.getByTestId('note-title')).toHaveValue('Alpha');
    await page.locator('.tab-strip').getByTestId('app-forward').click();
    await expect(page.getByTestId('note-title')).toHaveValue('Bravo');
    const pinButton = page.locator('.tab-strip').getByTestId('keep-on-top');
    await pinButton.click();
    await expect(pinButton).toHaveAttribute('aria-pressed', 'true');
    await pinButton.click();
    await expect(pinButton).toHaveAttribute('aria-pressed', 'false');

    // Without the compact title bar (a browser, the native title bar, full screen): from the
    // rail's edge.
    await page.evaluate(() => delete document.documentElement.dataset['titlebar']);
    const rail = await box(page, '.sidebar');
    const flush = await box(page, '.tab-strip [data-testid="app-back"]');
    expect(flush.x).toBeCloseTo(rail.x + rail.width, 0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-6-browser.png` });

    // The graph (as Home and Trash) shows under the tab strip too since PEN-140: they stay there.
    await page.locator('.sidebar [data-command="app.graph"]').click();
    await expect(page.locator('.graph-page')).toBeVisible();
    await expect(page.locator('.tab-strip').getByTestId('app-back')).toBeVisible();
    await expect(page.locator('.sidebar').getByTestId('app-back')).toHaveCount(0);
    // A note that is not there has the strip, with them.
    await page.goto('/notes/01ZZZZZZZZZZZZZZZZZZZZZZZZ');
    await expect(page.getByTestId('note-not-found')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.tab-strip').getByTestId('app-back')).toBeVisible();
    await expect(page.locator('.sidebar').getByTestId('app-back')).toHaveCount(0);
    await expand(page);
    await expect(head.getByTestId('app-back')).toBeVisible();
    expect(errors).toEqual([]);
  });

  // PEN-135, item 7.
  for (const mode of ['Light', 'Dark'] as const) {
    test(`the note’s title bar is in the sidebar’s colour, apart from the text (${mode})`, async ({
      page,
    }) => {
      const errors = collectErrors(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await chooseMode(page, mode);
      await openNote(page, 'Alpha');
      const sidebar = await background(page, '.sidebar');
      // The tab strip, the main window's first row since PEN-140 (A1505).
      expect(await background(page, '.tab-strip')).toBe(sidebar);
      expect(await background(page, 'body')).not.toBe(sidebar);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-135-7-${mode.toLowerCase()}.png` });
      // Beside the rail in the compact window, the row over the rail's column takes it too.
      await collapse(page);
      if (SHOTS) {
        await page.screenshot({ path: `${SHOTS}/pen-135-7-${mode.toLowerCase()}-rail.png` });
      }
      await expand(page);
      expect(errors).toEqual([]);
    });
  }
});
