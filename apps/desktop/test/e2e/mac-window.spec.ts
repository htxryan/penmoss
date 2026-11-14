import { expect, test, type ElectronApplication, type JSHandle, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NO_DRAG_CONTROLS,
  NO_DRAG_SURFACES,
  TITLE_BAR_ROWS,
  UNDER_ROWS,
} from '../../../web/src/desktop/no-drag';
import { TITLE_BAR_INSET, TITLE_BAR_ROW, TRAFFIC_LIGHTS } from '../../src/mac-window';
import {
  body,
  capturePage,
  launch,
  mainBounds,
  removeDataDirs,
  gitNotebook,
  ULID,
  type Launched,
} from './support';

// T46 keep on top (#109, D38, A720, A721) and T47 the compact title bar (#110, D39, A722–A724),
// the issues' "Mac suite". Under xvfb the app stands in for a Mac (A725): the page lays out and
// behaves as on a Mac while the window keeps Linux's frame, so these check the windows' state,
// the layout's geometry against the traffic lights' area, the drag regions and the setting.
// The lights themselves, dragging and double-clicking (Chromium's own, A723) are checked by hand
// on a Mac (docs/desktop.md, step 15).

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const RUN = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const WINDOW = /^app:\/\/penmoss\/window\/notes\/[0-9A-HJKMNP-TV-Z]{26}$/;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

async function start(options: Parameters<typeof launch>[0] = {}): Promise<Launched> {
  const launched = await launch({ macWindow: true, ...options });
  opened.push(launched);
  await mainBounds(launched.app, { x: 0, y: 0, width: 1100, height: 760 });
  return launched;
}

async function quit(launched: Launched): Promise<void> {
  opened.splice(opened.indexOf(launched), 1);
  await launched.app.close();
}

/** The main process's test hooks (main.ts). */
interface Hooks {
  penmossDesktop: {
    mainWindow(): Electron.BrowserWindow | null;
    noteWindows(): Electron.BrowserWindow[];
    captureWindow(): Electron.BrowserWindow | null;
    titleBarOf(window: Electron.BrowserWindow): 'compact' | 'native' | null;
    holdingInput(): boolean;
  };
}

type Which = 'main' | number;

/** The main window or a note window, in the main process. */
const windowOf = (
  app: ElectronApplication,
  which: Which,
): Promise<JSHandle<Electron.BrowserWindow>> =>
  app.evaluateHandle((_electron, target) => {
    const hooks = (globalThis as unknown as Hooks).penmossDesktop;
    return target === 'main' ? hooks.mainWindow()! : hooks.noteWindows()[target]!;
  }, which);

const onTop = async (app: ElectronApplication, which: Which) =>
  (await windowOf(app, which)).evaluate((window) => window.isAlwaysOnTop());

const titleBarOf = async (app: ElectronApplication, which: Which) =>
  (await windowOf(app, which)).evaluate((window) =>
    (globalThis as unknown as Hooks).penmossDesktop.titleBarOf(window),
  );

const boundsOf = async (app: ElectronApplication, which: Which) =>
  (await windowOf(app, which)).evaluate((window) => window.getBounds());

/** A window event, as macOS sends it (xvfb has no window manager): `focus`, full screen. */
const emit = async (app: ElectronApplication, which: Which, event: string) =>
  (await windowOf(app, which)).evaluate((window, name) => void window.emit(name), event);

/** Brings a window to the front as macOS does. */
const focus = (app: ElectronApplication, which: Which) => emit(app, which, 'focus');

/** Chooses a menu item, as a click on it would. */
const chooseMenu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    (Menu.getApplicationMenu()?.getMenuItemById(itemId) as unknown as { click(): void }).click();
  }, id);

/** View → Keep on top's tick in the menu bar now. */
const ticked = (app: ElectronApplication) =>
  app.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('window.keepOnTop')?.checked,
  );

async function newNote(page: Page, title: string, text: string): Promise<string> {
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  // Each line is a paragraph of its own, and the text has no line breaks between them.
  await expect(body(page)).toContainText(text.replaceAll('\n', ''));
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

async function openNoteWindow(app: ElectronApplication, title: string): Promise<Page> {
  const [window] = await Promise.all([
    app.waitForEvent('window'),
    chooseMenu(app, 'note.openInNewWindow'),
  ]);
  await expect(window).toHaveURL(WINDOW);
  await expect(window.getByTestId('note-title')).toHaveValue(title);
  await expect(window.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return window;
}

/** Runs a command from the palette, as a person would. */
async function fromPalette(page: Page, query: string, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill(query);
  await expect(palette.getByRole('option').first()).toContainText(title);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

test('keep on top: the menu, the command and the pin stay in step per window; the main window remembers it', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  const title = `Pinned ${RUN}`;
  await newNote(page, title, `Keep me in sight ${RUN}.`);

  // The pin is in the main window's sidebar header; nothing is pinned yet.
  const pin = page.locator('.sb-head').getByTestId('keep-on-top');
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  expect(await onTop(app, 'main')).toBe(false);
  await expect.poll(() => ticked(app)).toBe(false);

  // The pin button.
  await pin.click();
  await expect.poll(() => onTop(app, 'main')).toBe(true);
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => ticked(app)).toBe(true);
  // View → Keep on top.
  await chooseMenu(app, 'window.keepOnTop');
  await expect.poll(() => onTop(app, 'main')).toBe(false);
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => ticked(app)).toBe(false);
  // The command, from the palette.
  await fromPalette(page, 'keep on top', 'Keep on Top');
  await expect.poll(() => onTop(app, 'main')).toBe(true);
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => ticked(app)).toBe(true);

  // A note window starts unpinned, with its own pin in its top bar (A721).
  const window = await openNoteWindow(app, title);
  const windowPin = window.locator('.note-top').getByTestId('keep-on-top');
  await expect(windowPin).toHaveAttribute('aria-pressed', 'false');
  expect(await onTop(app, 0)).toBe(false);
  // The menu's tick is the window in front's.
  await focus(app, 0);
  await expect.poll(() => ticked(app)).toBe(false);
  await windowPin.click();
  await expect.poll(() => onTop(app, 0)).toBe(true);
  await expect(windowPin).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => ticked(app)).toBe(true);
  // View → Keep on top acts on the window in front, not the main window.
  await chooseMenu(app, 'window.keepOnTop');
  await expect.poll(() => onTop(app, 0)).toBe(false);
  await expect(windowPin).toHaveAttribute('aria-pressed', 'false');
  expect(await onTop(app, 'main')).toBe(true);
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await focus(app, 'main');
  await expect.poll(() => ticked(app)).toBe(true);
  // A narrow note window hides its top bar: the pin is in its app bar.
  await (await windowOf(app, 0)).evaluate((target) => target.setBounds({ width: 600 }));
  const narrowPin = window.locator('.app-bar').getByTestId('keep-on-top');
  await expect(narrowPin).toBeVisible();
  await expect(narrowPin).toHaveAttribute('aria-pressed', 'false');
  // Pinned again before quitting: note windows are never restored, pinned or not.
  await focus(app, 0);
  await narrowPin.click();
  await expect.poll(() => onTop(app, 0)).toBe(true);
  await expect(narrowPin).toHaveAttribute('aria-pressed', 'true');

  // The main window's pin is in window-state.json, and survives a relaunch (A721).
  const state = JSON.parse(
    readFileSync(join(launched.userData, 'window-state.json'), 'utf8'),
  ) as Record<string, unknown>;
  expect(state['keepOnTop']).toBe(true);
  expect(launched.errors).toEqual([]);
  await quit(launched);

  const again = await start({ userData: launched.userData });
  await expect(again.page.locator('.sb-head').getByTestId('keep-on-top')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await onTop(again.app, 'main')).toBe(true);
  expect(
    await again.app.evaluate(
      () => (globalThis as unknown as Hooks).penmossDesktop.noteWindows().length,
    ),
  ).toBe(0);
  // Unpinned, it stays unpinned after the next relaunch.
  await again.page.locator('.sb-head').getByTestId('keep-on-top').click();
  await expect.poll(() => onTop(again.app, 'main')).toBe(false);
  await quit(again);
  const third = await start({ userData: launched.userData });
  await expect(third.page.locator('.sb-head').getByTestId('keep-on-top')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(await onTop(third.app, 'main')).toBe(false);
});

/** What is shown inside the traffic lights' area, with a margin: none of it may be. */
function overLights(page: Page): Promise<string[]> {
  return page.evaluate(
    ([lights, margin]) => {
      const area = {
        left: lights.x - margin,
        top: lights.y - margin,
        right: lights.x + lights.width + margin,
        bottom: lights.y + lights.height + margin,
      };
      const shown = document.querySelectorAll<HTMLElement>(
        'button, a[href], input, textarea, select, [role="button"], [contenteditable="true"], .brand, .crumbs li, .app-bar-title, .doc-title, h1, h2',
      );
      const over: string[] = [];
      for (const element of shown) {
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden') continue;
        // What shows of it: clipped by every box that scrolls or hides its overflow.
        const rect = element.getBoundingClientRect();
        const box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        for (let up = element.parentElement; up; up = up.parentElement) {
          const { overflowX, overflowY } = getComputedStyle(up);
          if (overflowX === 'visible' && overflowY === 'visible') continue;
          const clip = up.getBoundingClientRect();
          box.left = Math.max(box.left, clip.left);
          box.top = Math.max(box.top, clip.top);
          box.right = Math.min(box.right, clip.right);
          box.bottom = Math.min(box.bottom, clip.bottom);
        }
        const width = box.right - box.left;
        const height = box.bottom - box.top;
        if (width <= 0 || height <= 0) continue;
        if (element.closest('[inert], [hidden], .pm-visually-hidden')) continue;
        const hits =
          box.left < area.right &&
          box.right > area.left &&
          box.top < area.bottom &&
          box.bottom > area.top;
        if (hits) {
          const name =
            element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 30) ?? '';
          over.push(
            `${element.tagName.toLowerCase()}.${element.className} "${name}" at ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(width)}×${Math.round(height)}`,
          );
        }
      }
      return over;
    },
    [TRAFFIC_LIGHTS, 4] as const,
  );
}

/** `-webkit-app-region` of the first element `selector` finds. */
const region = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region'));

/**
 * What would drag the window instead of taking a click (A723): every visible control, and every
 * floating surface, whose `-webkit-app-region` is not `no-drag`. With `top`, only those reaching
 * into the first row (the part of the window a drag region can be in); else anywhere.
 */
const draggable = (page: Page, top: boolean) =>
  page.evaluate(
    ([controls, surfaces, under, rows, row, onlyTop]) => {
      const found: string[] = [];
      const surface = surfaces.join(', ');
      const titleRow = rows.join(', ');
      for (const element of document.querySelectorAll<HTMLElement>(
        [...controls, ...surfaces].join(', '),
      )) {
        if (element.closest('[inert], [hidden]')) continue;
        // A row is meant to drag, though it may be a toolbar too (the graph's bar).
        if (element.matches(titleRow)) continue;
        // A note's own controls scroll under its top bar and set no region (A1123); the
        // hit-test below checks nothing in a row takes a click.
        if (!element.matches(surface) && element.closest(under.join(', '))) continue;
        if (getComputedStyle(element).visibility === 'hidden') continue;
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        if (onlyTop && box.top >= row) continue;
        const region = getComputedStyle(element).getPropertyValue('-webkit-app-region');
        if (region === 'no-drag') continue;
        const name = element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '';
        found.push(`${element.tagName.toLowerCase()}.${element.className} "${name.slice(0, 30)}"`);
      }
      return found;
    },
    [NO_DRAG_CONTROLS, NO_DRAG_SURFACES, UNDER_ROWS, TITLE_BAR_ROWS, TITLE_BAR_ROW, top] as const,
  );

/**
 * The region Electron gives the point (A723, A1123): of the elements with one there, the last in
 * the DOM wins, as later regions are applied over earlier ones.
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
        const box = element.getBoundingClientRect();
        if (px >= box.left && px < box.right && py >= box.top && py < box.bottom) won = value;
      }
      return won;
    },
    [x, y] as const,
  );

/** What the list-free check leaves in the page between its steps. */
interface RegionCheck {
  rows: Element[];
  candidates: Element[];
}
interface Probe {
  /** The drag region the point is in, and what is up the chain from the element hit there. */
  samples: { row: number; chain: number[] }[];
  /** Whether each candidate takes a click on its own looks: cursor, tab stop, React handler. */
  takes: boolean[];
}
const CLICKS = new Set(['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']);

/**
 * What takes a click in a drag region without being sure to be `no-drag` (A723), found without
 * `no-drag.ts`'s lists, so a control left out of them fails too. Every element whose computed
 * `-webkit-app-region` is `drag` (and whose parent's is not) is a drag region; every point of it 4 px apart is hit-tested,
 * and the first element up from what is hit (stopping at the region) that takes a click counts:
 * a pointer or text cursor, a tab stop, a React handler (React listens at the root, so its
 * handlers are read from the element's props) or a DOM click listener (CDP's
 * `DOMDebugger.getEventListeners`). That element must be `no-drag`, itself or from the nearest
 * ancestor that sets a region, and that region must be nested in the drag region or come after
 * it in the DOM: Electron applies later regions over earlier ones, so a `no-drag` before the
 * row is only safe if regions are collected in paint order, which nothing here relies on.
 */
async function clicksThatDrag(page: Page): Promise<string[]> {
  const probe = await page.evaluate((step): Probe => {
    const regionOf = (element: Element) =>
      getComputedStyle(element).getPropertyValue('-webkit-app-region');
    // A region is inherited: a drag region is the outermost element of a run that drags.
    const rows = [...document.querySelectorAll('body *')].filter((element) => {
      const box = element.getBoundingClientRect();
      const parent = element.parentElement;
      return (
        regionOf(element) === 'drag' &&
        !(parent && regionOf(parent) === 'drag') &&
        box.width > 0 &&
        box.height > 0
      );
    });
    const candidates: Element[] = [];
    const index = new Map<Element, number>();
    const add = (element: Element) => {
      if (!index.has(element)) {
        index.set(element, candidates.length);
        candidates.push(element);
      }
      return index.get(element)!;
    };
    const seen = new Set<string>();
    const samples: Probe['samples'] = [];
    rows.forEach((row, at) => {
      const box = row.getBoundingClientRect();
      const [left, top] = [Math.max(box.left, 0) + 1, Math.max(box.top, 0) + 1];
      const [right, bottom] = [Math.min(box.right, innerWidth), Math.min(box.bottom, innerHeight)];
      for (let y = top; y < bottom; y += step) {
        for (let x = left; x < right; x += step) {
          const chain: number[] = [];
          for (let up = document.elementFromPoint(x, y); up; up = up.parentElement) {
            if (up === document.body || up.id === 'root') break;
            chain.push(add(up));
            if (up === row) break;
          }
          const key = `${at}:${chain.join(',')}`;
          if (chain.length > 0 && !seen.has(key)) {
            seen.add(key);
            samples.push({ row: at, chain });
          }
        }
      }
    });
    (window as unknown as { penmossRegionCheck: RegionCheck }).penmossRegionCheck = {
      rows,
      candidates,
    };
    const handlers = ['onClick', 'onDoubleClick', 'onMouseDown', 'onMouseUp', 'onPointerDown'];
    const takes = candidates.map((element) => {
      const { cursor } = getComputedStyle(element);
      const key = Object.keys(element).find((name) => name.startsWith('__reactProps$'));
      const props = key ? (element as unknown as Record<string, Record<string, unknown>>)[key] : {};
      return (
        cursor === 'pointer' ||
        cursor === 'text' ||
        (element as HTMLElement).tabIndex >= 0 ||
        handlers.some((name) => typeof props?.[name] === 'function')
      );
    });
    return { samples, takes };
  }, 4);

  // DOM listeners, for what its looks did not already say takes a click.
  const asked = new Set<number>();
  for (const { chain } of probe.samples) {
    for (const at of chain) {
      if (probe.takes[at]) break;
      asked.add(at);
    }
  }
  const cdp = await page.context().newCDPSession(page);
  for (const at of asked) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `window.penmossRegionCheck.candidates[${at}]`,
    });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId!,
      depth: 0,
    });
    if (listeners.some((listener) => CLICKS.has(listener.type))) probe.takes[at] = true;
  }
  await cdp.detach();

  return page.evaluate(({ samples, takes }) => {
    const { rows, candidates } = (window as unknown as { penmossRegionCheck: RegionCheck })
      .penmossRegionCheck;
    const regionOf = (element: Element) =>
      getComputedStyle(element).getPropertyValue('-webkit-app-region');
    const name = (element: Element) =>
      `${element.tagName.toLowerCase()}.${element.getAttribute('class') ?? ''} "${(element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '').slice(0, 30)}"`;
    const found = new Set<string>();
    for (const { row: at, chain } of samples) {
      const first = chain.find((index) => takes[index]);
      if (first === undefined) continue;
      const row = rows[at]!;
      const element = candidates[first]!;
      let source: Element | null = element;
      while (source && !['drag', 'no-drag'].includes(regionOf(source))) {
        source = source.parentElement;
      }
      const why =
        !source || regionOf(source) !== 'no-drag'
          ? 'drags'
          : row.contains(source) ||
              (row.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
            ? null
            : `its no-drag (${name(source)}) comes before the row in the DOM`;
      if (why) found.add(`${name(element)} in ${name(row)}: ${why}`);
    }
    return [...found];
  }, probe);
}

/**
 * Waits for the page's CSS transitions to end. The hit-test reads where things are drawn, so it
 * must not run mid-slide: at 700 px and below the sidebar is a drawer, and the narrow window's
 * check once caught it sliding away over the app bar (PEN-112).
 */
async function transitionsEnded(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((animation) => animation instanceof CSSTransition)
            .filter((animation) => animation.playState === 'running').length,
      ),
    )
    .toBe(0);
}

/** Nothing that clicks drags: at the top of the window, and in the rows anywhere. */
async function clicksEverywhere(
  page: Page,
  where: string,
  { stopped = [] }: { stopped?: readonly string[] } = {},
): Promise<void> {
  await transitionsEnded(page);
  expect(await draggable(page, true), where).toEqual([]);
  expect(await clicksThatDrag(page), where).toEqual([]);
  // The rows themselves drag, but for those a surface before them in the DOM is open over.
  const rows = await page.evaluate(
    ([selectors, except]) =>
      [...document.querySelectorAll<HTMLElement>(selectors.join(', '))]
        .filter((row) => row.getBoundingClientRect().height > 0)
        .map((row) => [
          except.some((selector) => row.matches(selector)),
          getComputedStyle(row).getPropertyValue('-webkit-app-region'),
        ]),
    [TITLE_BAR_ROWS, stopped] as const,
  );
  for (const [still, region] of rows) {
    expect(region, where).toBe(still ? 'no-drag' : 'drag');
  }
}

/** Scrolls whatever scrolls around `selector` by `by` pixels. */
const scrollAround = (page: Page, selector: string, by: number) =>
  page
    .locator(selector)
    .first()
    .evaluate((element, distance) => {
      for (let up: Element | null = element; up; up = up.parentElement) {
        const { overflowY } = getComputedStyle(up);
        if ((overflowY === 'auto' || overflowY === 'scroll') && up.scrollHeight > up.clientHeight) {
          up.scrollTop += distance;
          return up.scrollTop;
        }
      }
      const root = document.scrollingElement!;
      root.scrollTop += distance;
      return root.scrollTop;
    }, by);

const compactNow = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset['titlebar'] ?? null);

test('the compact title bar: room for the lights in every layout, rows that drag, none in full screen', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  const title = `Compact ${RUN}`;
  await newNote(page, title, `Under the lights ${RUN}.`);

  expect(await titleBarOf(app, 'main')).toBe('compact');
  expect(await compactNow(page)).toBe('compact');

  // The sidebar open: its header is the first row, as tall as the note's top bar.
  const head = page.locator('.sb-head');
  expect((await head.boundingBox())!.height).toBe(TITLE_BAR_ROW);
  // The note's top bar: the row, and its 1 px border below.
  expect((await page.locator('.note-top').boundingBox())!.height).toBe(TITLE_BAR_ROW + 1);
  expect((await page.locator('.sb-head .brand').boundingBox())!.x).toBeGreaterThanOrEqual(
    TITLE_BAR_INSET,
  );
  // Back and Forward start the first row, after the lights (T51, A943).
  expect((await page.getByTestId('app-back').boundingBox())!.x).toBeGreaterThanOrEqual(
    TITLE_BAR_INSET,
  );
  expect(await overLights(page)).toEqual([]);
  // The rows drag; every control in them still clicks.
  expect(await region(page, '.sb-head')).toBe('drag');
  expect(await region(page, '.note-top')).toBe('drag');
  // No strip behind the page: only the rows drag (A723).
  await expect(page.locator('.window-drag')).toHaveCount(0);
  await clicksEverywhere(page, 'main window');

  // At full width.
  await page.getByTestId('toggle-full-width').click();
  await expect(page.locator('.note')).toHaveAttribute('data-width', 'full');
  expect(await overLights(page)).toEqual([]);
  await page.getByTestId('toggle-full-width').click();

  // As a rail (T52): one button wide; the lights sit in the note's title row, which runs over the
  // rail's column, and the rail's buttons start below that row.
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
  const toggle = (await page.getByTestId('toggle-sidebar').boundingBox())!;
  expect(toggle.y).toBeGreaterThanOrEqual(TITLE_BAR_ROW);
  expect(toggle.width).toBe(34);
  // The rail is the button's width and its border, with no margin around the button.
  const rail = (await page.locator('.sidebar').boundingBox())!;
  expect(rail.x).toBe(0);
  expect(rail.width).toBe(toggle.width + 1);
  expect(toggle.x).toBe(0);
  // Settings and Send Feedback at the rail's foot (PEN-135 item 4).
  for (const id of ['sidebar-settings', 'sidebar-feedback']) {
    const button = (await page.getByTestId(id).boundingBox())!;
    expect(button.x, id).toBe(0);
    expect(button.width, id).toBe(toggle.width);
  }
  expect(
    (await page.getByTestId('sidebar-feedback').boundingBox())!.y +
      (await page.getByTestId('sidebar-feedback').boundingBox())!.height,
  ).toBeCloseTo(rail.y + rail.height, 0);
  // The note's title row starts at the rail's edge, under the lights (the row drags, as the
  // sidebar's head does); what it holds starts after their inset: Back, Forward and the pin, then
  // the crumbs (PEN-135 item 6). The rail keeps none of them beside a note.
  const top = (await page.locator('.note-top').boundingBox())!;
  expect(top.x).toBe(rail.width);
  expect(top.height).toBe(TITLE_BAR_ROW + 1);
  const back = (await page.locator('.note-top').getByTestId('app-back').boundingBox())!;
  const pin = (await page.locator('.note-top').getByTestId('keep-on-top').boundingBox())!;
  expect(back.x).toBeGreaterThanOrEqual(TITLE_BAR_INSET);
  expect(back.y).toBeLessThan(TITLE_BAR_ROW);
  expect(pin.x).toBeGreaterThan(back.x);
  await expect(page.locator('.sidebar').getByTestId('app-back')).toHaveCount(0);
  await expect(page.locator('.sidebar').getByTestId('keep-on-top')).toHaveCount(0);
  expect((await page.locator('.note-top .crumbs').boundingBox())!.x).toBeGreaterThan(
    pin.x + pin.width,
  );
  expect(await overLights(page)).toEqual([]);
  expect(await region(page, '.note-top')).toBe('drag');
  await clicksEverywhere(page, 'main window');
  // Home, Trash and the graph beside the rail: no note's title bar, so the rail keeps Back and
  // Forward, one pair as wide as the rail, below the row.
  for (const [command, ready] of [
    ['app.home', '.home'],
    ['app.trash', '[data-testid="trash"]'],
    ['app.graph', '.graph-page'],
  ] as const) {
    await chooseMenu(app, command);
    await expect(page.locator(ready)).toBeVisible();
    const railBack = (await page.locator('.sidebar').getByTestId('app-back').boundingBox())!;
    const railForward = (await page.locator('.sidebar').getByTestId('app-forward').boundingBox())!;
    expect(railBack.y, command).toBeGreaterThanOrEqual(TITLE_BAR_ROW);
    expect(railBack.x, command).toBe(0);
    expect(railForward.x + railForward.width, command).toBe(toggle.width);
    expect(await overLights(page), command).toEqual([]);
    expect((await page.locator('.note-main').boundingBox())!.x, command).toBe(rail.width);
    await clicksEverywhere(page, command);
  }
  expect(await region(page, '.pm-graph-bar')).toBe('drag');
  // The graph's bar is the title row there: as tall as the note's, its controls after the lights.
  expect((await page.locator('.pm-graph-bar').boundingBox())!.height).toBeGreaterThanOrEqual(
    TITLE_BAR_ROW + 1,
  );
  expect((await page.locator('.pm-graph-bar > *').first().boundingBox())!.x).toBeGreaterThanOrEqual(
    TITLE_BAR_INSET,
  );
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).not.toHaveAttribute('data-sidebar', 'collapsed');

  // Settings: its bar is the first row.
  await chooseMenu(app, 'app.appearance');
  await expect(page.getByTestId('appearance-settings')).toBeVisible();
  expect(await overLights(page)).toEqual([]);
  expect(await region(page, '.settings-bar')).toBe('drag');
  await clicksEverywhere(page, 'main window');

  // A narrow window: the app bar, and the drawer over it.
  await mainBounds(app, { x: 0, y: 0, width: 600, height: 760 });
  await expect(page.locator('.settings-bar')).toBeVisible();
  expect(await overLights(page)).toEqual([]);
  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(page.getByTestId('app-bar')).toBeVisible();
  expect(await overLights(page)).toEqual([]);
  expect(await region(page, '.app-bar')).toBe('drag');
  await page.getByRole('button', { name: 'Open Navigation' }).click();
  await expect(page.locator('.notes-app')).toHaveAttribute('data-drawer', 'open');
  await page.waitForTimeout(300); // The drawer slides in.
  expect(await overLights(page)).toEqual([]);
  // The drawer comes before the app bar in the DOM, so the app bar stops dragging under it, and
  // so does the empty home, with no note open (Ryan's review of #192, finding 6).
  await clicksEverywhere(page, 'narrow window, drawer open', { stopped: ['.app-bar', '.home'] });
  await page.keyboard.press('Escape');
  await mainBounds(app, { x: 0, y: 0, width: 1100, height: 760 });
  await expect(page.locator('.note-top')).toBeVisible();

  // Full screen hides the lights, and the room for them goes too.
  await emit(app, 'main', 'enter-full-screen');
  await expect.poll(() => compactNow(page)).toBeNull();
  expect((await head.boundingBox())!.height).not.toBe(TITLE_BAR_ROW);
  expect((await page.getByTestId('app-back').boundingBox())!.x).toBeLessThan(TITLE_BAR_INSET);
  expect(await region(page, '.sb-head')).not.toBe('drag');
  await emit(app, 'main', 'leave-full-screen');
  await expect.poll(() => compactNow(page)).toBe('compact');

  // A note window: its top bar, with Back and Forward after the lights.
  const noteWindow = await openNoteWindow(app, title);
  expect(await compactNow(noteWindow)).toBe('compact');
  expect((await noteWindow.locator('.note-top').boundingBox())!.height).toBe(TITLE_BAR_ROW + 1);
  expect((await noteWindow.getByTestId('window-back').boundingBox())!.x).toBeGreaterThanOrEqual(
    TITLE_BAR_INSET,
  );
  expect(await overLights(noteWindow)).toEqual([]);
  expect(await region(noteWindow, '.note-top')).toBe('drag');
  await clicksEverywhere(noteWindow, 'note window');

  // The capture window is as it was: no title-bar layout, no window behaviours.
  const capture = await capturePage(app);
  expect(await compactNow(capture)).toBeNull();
  expect(await capture.evaluate(() => 'macWindow' in (window.penmossDesktop ?? {}))).toBe(false);
  expect(launched.errors).toEqual([]);
});

/** The windows the app shows now (not the capture window), once `count` of them are loaded. */
async function shownWindows(app: ElectronApplication, count: number): Promise<Page[]> {
  const find = () =>
    app
      .windows()
      .filter((view) => !view.isClosed() && !view.url().endsWith('/capture'))
      .filter((view) => view.url().startsWith('app://penmoss/'));
  await expect.poll(() => find().length, { timeout: 20_000 }).toBe(count);
  return find();
}

/** Stands in for the question the setting asks (`dialog.showMessageBox`): `answer` is the button. */
const answerDialog = (app: ElectronApplication, answer: 0 | 1) =>
  app.evaluate(({ dialog }, button) => {
    const asked = ((globalThis as { asked?: string[] }).asked ??= []);
    dialog.showMessageBox = ((_window: unknown, options: Electron.MessageBoxOptions) => {
      asked.push(options.message);
      return Promise.resolve({ response: button, checkboxChecked: false });
    }) as typeof dialog.showMessageBox;
  }, answer);

const askedSoFar = (app: ElectronApplication) =>
  app.evaluate(() => [...((globalThis as { asked?: string[] }).asked ?? [])]);

test('the setting asks first, then reopens the windows with the other title bar; Cancel leaves them', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  const title = `Reopened ${RUN}`;
  const id = await newNote(page, title, `Still here ${RUN}.`);
  const window = await openNoteWindow(app, title);
  await window.locator('.note-top').getByTestId('keep-on-top').click();
  await expect.poll(() => onTop(app, 0)).toBe(true);
  const noteBounds = await boundsOf(app, 0);
  const titleTop = (view: Page) =>
    view.getByTestId('note-title').evaluate((element) => element.getBoundingClientRect().top);
  const compactTitleTop = await titleTop(window);
  const contentOffset = async (which: Which) =>
    (await windowOf(app, which)).evaluate(
      (target) => target.getContentBounds().y - target.getBounds().y,
    );
  const compactOffset = await contentOffset(0);
  const captureId = await app.evaluate(
    () => (globalThis as unknown as Hooks).penmossDesktop.captureWindow()!.webContents.id,
  );

  // Settings → Appearance → Compact title bar: on by default, this Mac's own.
  await chooseMenu(app, 'app.appearance');
  const setting = page.getByTestId('compact-title-bar');
  await expect(setting).toBeChecked();

  // Cancel: nothing changes and no window reopens.
  await answerDialog(app, 1);
  await setting.uncheck();
  await expect.poll(() => askedSoFar(app)).toEqual(['Use the standard title bar?']);
  await expect(setting).toBeChecked();
  await expect(setting).toBeEnabled();
  expect(page.isClosed()).toBe(false);
  expect(window.isClosed()).toBe(false);

  // Reopen: every main and note window closes and opens again with macOS's title bar.
  // (A click: the page closes before `uncheck` could read the box again.)
  await answerDialog(app, 0);
  await setting.click();
  await expect.poll(() => page.isClosed()).toBe(true);
  await expect.poll(() => window.isClosed()).toBe(true);
  const reopened = await shownWindows(app, 2);
  const main = reopened.find((view) => !WINDOW.test(view.url()))!;
  const note = reopened.find((view) => WINDOW.test(view.url()))!;
  // Where they were: Settings in the main window, the note in its window, pinned and in place.
  await expect(main).toHaveURL(/\/settings\/appearance$/);
  await expect(note).toHaveURL(`app://penmoss/window/notes/${id}`);
  await expect(note.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  expect(await boundsOf(app, 0)).toEqual(noteBounds);
  expect(await onTop(app, 0)).toBe(true);
  await expect(note.locator('.note-top').getByTestId('keep-on-top')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Input is no longer held.
  expect(
    await app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.holdingInput()),
  ).toBe(false);
  // The other title bar: nothing left for the lights.
  expect(await titleBarOf(app, 'main')).toBe('native');
  expect(await titleBarOf(app, 0)).toBe('native');
  expect(await compactNow(main)).toBeNull();
  expect(await compactNow(note)).toBeNull();
  expect(await region(note, '.note-top')).not.toBe('drag');
  await expect(main.getByTestId('compact-title-bar')).not.toBeChecked();
  // The note sits where it did inside the page: on a Mac the window's own title bar now comes
  // above it, so in a compact window it starts that much higher (A722). That bar is macOS's
  // height, not Penmoss's (28 px before macOS 26, 32 px since): measured on a plain window.
  expect(await titleTop(note)).toBe(compactTitleTop);
  if (mac) {
    const macTitleBar = await app.evaluate(({ BrowserWindow }) => {
      const probe = new BrowserWindow({ show: false, width: 400, height: 300 });
      const height = probe.getContentBounds().y - probe.getBounds().y;
      probe.destroy();
      return height;
    });
    expect(macTitleBar).toBeGreaterThanOrEqual(28);
    expect((await contentOffset(0)) - compactOffset).toBe(macTitleBar);
  } else expect(await contentOffset(0)).toBe(compactOffset);
  // Kept for this Mac only, beside the hotkey.
  const preferences = JSON.parse(
    readFileSync(join(launched.userData, 'preferences.json'), 'utf8'),
  ) as Record<string, unknown>;
  expect(preferences['compactTitleBar']).toBe(false);
  // The capture window is never reopened.
  expect(
    await app.evaluate(
      () => (globalThis as unknown as Hooks).penmossDesktop.captureWindow()!.webContents.id,
    ),
  ).toBe(captureId);

  // And back: compact again.
  await main.getByTestId('compact-title-bar').click();
  await expect.poll(() => main.isClosed()).toBe(true);
  const back = await shownWindows(app, 2);
  const mainAgain = back.find((view) => !WINDOW.test(view.url()))!;
  await expect.poll(() => compactNow(mainAgain)).toBe('compact');
  expect(await askedSoFar(app)).toEqual([
    'Use the standard title bar?',
    'Use the standard title bar?',
    'Use the compact title bar?',
  ]);
});

test('nothing that clicks drags the window: Version history, scrolled Settings and Trash, menus over the top', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  // Notes for Trash to list, then one to keep open.
  for (const n of [1, 2, 3, 4]) {
    await newNote(page, `Trashed ${n} ${RUN}`, `Gone ${n}.`);
    await chooseMenu(app, 'note.delete');
    await expect(page).not.toHaveURL(ULID);
  }
  await newNote(page, `Kept ${RUN}`, `Under the panel ${RUN}.`);

  // Version history: the History tab of the note's panel since T51 (A936). In an 1100 px window
  // with the sidebar open the note's pane is under 60rem, too narrow for the side panel beside
  // the text, so it lies over the text (T53 item 9, A985), below the lights' row; nothing in it
  // drags.
  await chooseMenu(app, 'note.history');
  const panel = page.getByTestId('history-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'History' })).toBeVisible();
  await expect(page.locator('.note-columns')).toHaveAttribute('data-over', '');
  await clicksEverywhere(page, 'version history');
  // The panel is in the note's columns, below the first row: its controls set no region of their
  // own (A1123), so none drags; the hit-test above checks that nothing in a row takes a click.
  expect(await region(page, '[role="tab"][data-tab="history"]')).not.toBe('drag');
  expect(await region(page, '[data-testid="note-panel-close"]')).not.toBe('drag');
  expect(await overLights(page)).toEqual([]);
  // In a narrower window still: nothing over the lights.
  await mainBounds(app, { x: 0, y: 0, width: 600, height: 760 });
  // The page has the new size before anything is measured: setBounds returns before it does.
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(600);
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(panel).toBeAttached();
  expect(await overLights(page)).toEqual([]);
  await clicksEverywhere(page, 'version history, narrow');
  await chooseMenu(app, 'note.history');
  await expect(panel).toHaveCount(0);
  await mainBounds(app, { x: 0, y: 0, width: 1100, height: 760 });

  // A long note scrolled (Quanta feedback 2, item 6; A1123): its title and text go up under its
  // top bar, and the bar's empty part still moves the window.
  await newNote(
    page,
    `Long ${RUN}`,
    Array.from({ length: 60 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n'),
  );
  expect(await scrollAround(page, '.note-scroll', 900)).toBeGreaterThan(0);
  const bar = (await page.locator('.note-top').boundingBox())!;
  const actions = (await page.locator('.note-top .note-actions').boundingBox())!;
  const empty = { x: actions.x - 40, y: bar.y + bar.height / 2 };
  expect(await regionAt(page, empty.x, empty.y)).toBe('drag');
  // Over the breadcrumb's words too, as a Mac title drags; a button in the bar still clicks.
  expect(await regionAt(page, bar.x + 30, empty.y)).toBe('drag');
  expect(await regionAt(page, actions.x + 10, empty.y)).toBe('no-drag');
  await clicksEverywhere(page, 'note scrolled');

  // Settings scrolled: only its content scrolls; the bar, the heading and the sections' list
  // stay put (T51, A942).
  await chooseMenu(app, 'app.shortcuts');
  await expect(page.locator('.settings-content')).toBeVisible();
  const fixed = ['.settings-bar', '.settings-title > h1', '.settings-nav'];
  const tops = async () =>
    Promise.all(fixed.map(async (selector) => (await page.locator(selector).boundingBox())!.y));
  const before = await tops();
  expect(await scrollAround(page, '.settings-content', 900)).toBeGreaterThan(0);
  expect(
    await page.locator('.settings-content').evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
  expect(await tops()).toEqual(before);
  await clicksEverywhere(page, 'settings scrolled');

  // Trash scrolled, in a short window: Restore and Delete pass under the top.
  await mainBounds(app, { x: 0, y: 0, width: 1100, height: 420 });
  await chooseMenu(app, 'app.trash');
  await expect(page.getByTestId('trash')).toContainText(`Trashed 4 ${RUN}`);
  expect(await scrollAround(page, '[data-testid="trash"]', 400)).toBeGreaterThan(0);
  await clicksEverywhere(page, 'trash scrolled');

  // The sidebar's menu: flipped up from the bottom of a short window, and opened over the
  // first row. (A note's menu is about 124 px tall, so in the shortest window, 360 px, a flip
  // alone stops short of the first row; opened there, it covers it.)
  await mainBounds(app, { x: 0, y: 0, width: 1100, height: 360 });
  const row = page.getByRole('treeitem', { name: new RegExp(`Kept ${RUN}`) });
  // Beside the note, so a menu opened at the top reaches over its top bar.
  await row.click();
  await expect(page.locator('.note-top')).toBeVisible();
  const menuAt = (clientY: number) =>
    row.evaluate(
      (element, y) =>
        element.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 120,
            clientY: y,
          }),
        ),
      clientY,
    );
  const menu = page.locator('.context-menu');
  await menuAt(340);
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox())!.y).toBeLessThan(340 - 100);
  // The menu is in the sidebar, before the note's top bar in the DOM: that stops dragging.
  await clicksEverywhere(page, 'context menu flipped up', { stopped: ['.note-top'] });
  expect(await draggable(page, false), 'flipped menu').toEqual([]);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await menuAt(20);
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox())!.y).toBeLessThan(TITLE_BAR_ROW);
  // Out of the sidebar and over the note's top bar too.
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.x + menuBox.width).toBeGreaterThan(
    (await page.locator('.note-top').boundingBox())!.x,
  );
  await clicksEverywhere(page, 'context menu over the first row', { stopped: ['.note-top'] });
  expect(await draggable(page, false), 'menu over the first row').toEqual([]);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(await region(page, '.note-top')).toBe('drag');
  expect(launched.errors).toEqual([]);
});

/** Drops one window's request to store its notes, so its page never answers (a stuck save). */
const stallSaves = (app: ElectronApplication, which: Which, stalled: boolean) =>
  windowOf(app, which).then((handle) =>
    handle.evaluate((target, on) => {
      const contents = target.webContents as Electron.WebContents & {
        realSend?: typeof target.webContents.send;
      };
      contents.realSend ??= contents.send.bind(contents);
      contents.send = on
        ? (channel: string, ...args: unknown[]) => {
            if (channel !== 'penmoss:save') contents.realSend!(channel, ...args);
          }
        : contents.realSend;
    }, stalled),
  );

test('Settings: the heading keeps the page gutter, in line with Back and the sections (PEN-64)', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  await chooseMenu(app, 'app.shortcuts');
  const heading = page.locator('.settings-title > h1');
  await expect(heading).toBeVisible();
  await expect(page.locator('.settings-nav a').first()).toBeVisible();
  const leftOf = async (selector: string) =>
    (await page.locator(selector).first().boundingBox())!.x;
  // The heading starts at the sections' gutter, clear of the window's edge and the lights.
  const headingLeft = await leftOf('.settings-title > h1');
  expect(headingLeft).toBeGreaterThan(TITLE_BAR_INSET - 1);
  expect(Math.abs(headingLeft - (await leftOf('.settings-nav')))).toBeLessThanOrEqual(1);
  // Held on screen, so the proof's recording shows the heading in line.
  await page.waitForTimeout(2_000);
  await expect(heading).toBeInViewport();
});

test('reopening never loses what was just typed, and stops when a window cannot save', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  const title = `Typed then reopened ${RUN}`;
  const id = await newNote(page, title, `First ${RUN}.`);
  const window = await openNoteWindow(app, title);
  await chooseMenu(app, 'app.appearance');
  const setting = page.getByTestId('compact-title-bar');
  await expect(setting).toBeChecked();
  await answerDialog(app, 0);

  // A window whose save never answers: after 3 s nothing changes, and a dialog says why.
  await stallSaves(app, 0, true);
  await setting.uncheck();
  await expect
    .poll(() => askedSoFar(app), { timeout: 10_000 })
    .toEqual(['Use the standard title bar?', 'The title bar was not changed']);
  await expect(setting).toBeChecked();
  expect(window.isClosed()).toBe(false);
  expect(await titleBarOf(app, 0)).toBe('compact');
  expect(
    await app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.holdingInput()),
  ).toBe(false);
  expect(() => readFileSync(join(launched.userData, 'preferences.json'), 'utf8')).not.toThrow();
  expect(
    (
      JSON.parse(readFileSync(join(launched.userData, 'preferences.json'), 'utf8')) as Record<
        string,
        unknown
      >
    )['compactTitleBar'],
  ).toBeUndefined();
  await stallSaves(app, 0, false);

  // Typing in the note window, then the setting at once: the words are there after it reopens.
  await body(window).click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(` Typed just before ${RUN}.`);
  await setting.click();
  await expect.poll(() => window.isClosed()).toBe(true);
  const reopened = await shownWindows(app, 2);
  const note = reopened.find((view) => WINDOW.test(view.url()))!;
  await expect(note).toHaveURL(`app://penmoss/window/notes/${id}`);
  await expect(body(note)).toHaveText(`First ${RUN}. Typed just before ${RUN}.`);
  expect(await titleBarOf(app, 0)).toBe('native');
});
