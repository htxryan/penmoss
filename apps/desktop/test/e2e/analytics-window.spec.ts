import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  analyticsEnv,
  fakeAnalytics,
  sendNow,
  type FakeAnalytics,
  type WireEvent,
} from './fake-analytics';
import {
  body,
  capturePage,
  gitNotebook,
  go,
  holdForProof,
  launch,
  mainBounds,
  removeDataDirs,
  ULID,
  type Launched,
} from './support';

// PEN-174 in the Mac app: `app window`, recorded by main. The main window is recorded as it shows,
// at its size in CSS px rounded to 10 (ac1); a run of resizes records once, 500 ms after the last,
// and a move records nothing (ac2); full screen on and off record at once (ac3); maximising
// records once it settles; a note window and Quick Capture record their own. Main's check takes
// them, so they reach the endpoint with their props and nothing about the window's place (ac9).
// The page's `app layout` goes with them (ac6), and Settings → Privacy → View Analytics Data
// lists both: the full-screen pair, then the main, note and Quick Capture rows, where it ends.

const mac = process.platform === 'darwin';
const RUN = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';

const opened: Launched[] = [];
const endpoints: FakeAnalytics[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});
test.afterAll(() => removeDataDirs());

/** The main process's test hooks (main.ts). */
interface Hooks {
  penmossDesktop: {
    mainWindow(): Electron.BrowserWindow | null;
    noteWindows(): Electron.BrowserWindow[];
    showCapture(): void;
  };
}

interface Recorded {
  readonly id: number;
  readonly at: number;
  readonly kind: string;
  readonly name: string;
  readonly props: Readonly<Record<string, unknown>>;
}

/** The record on this Mac, oldest first. */
async function record(page: Page): Promise<Recorded[]> {
  const { events } = await page.evaluate(() =>
    window.penmossDesktop!.analytics!.page({ limit: 1000 }),
  );
  return (events as unknown as Recorded[]).slice().sort((a, b) => a.id - b.id);
}

/** The `app window` events of `which` window, oldest first. */
async function windowEvents(page: Page, which = 'main'): Promise<Recorded[]> {
  return (await record(page)).filter(
    (event) => event.kind === 'app' && event.name === 'window' && event.props.window === which,
  );
}

/** Moves, maximises or unmaximises the main window, as its title bar or green button would. */
const mainWindow = (
  app: ElectronApplication,
  method: 'setPosition' | 'maximize' | 'unmaximize',
  ...args: number[]
) =>
  app.evaluate(
    (_electron, [name, values]) => {
      const window = (globalThis as unknown as Hooks).penmossDesktop.mainWindow()!;
      (window[name] as (...given: number[]) => void).apply(window, values);
    },
    [method, args] as const,
  );

/** Turns full screen on or off, and answers main's clock as macOS says it is done. */
const fullScreen = (app: ElectronApplication, on: boolean) =>
  app.evaluate(async (_electron, wanted) => {
    const window = (globalThis as unknown as Hooks).penmossDesktop.mainWindow()!;
    const done = new Promise<number>((resolve) => {
      const finished = () => resolve(Date.now());
      if (wanted) window.once('enter-full-screen', finished);
      else window.once('leave-full-screen', finished);
    });
    window.setFullScreen(wanted);
    return done;
  }, on);

test('the Mac records each window’s size: as it shows, once a resize settles, and full screen at once (ac1–ac3, ac6, ac9)', async () => {
  test.setTimeout(240_000);
  const fake = await fakeAnalytics();
  endpoints.push(fake);
  const launched = await launch({ analytics: 'yes', env: analyticsEnv(fake) });
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  await gitNotebook(launched);

  // As it shows: the main window, at its content's size in CSS px, rounded to 10 (ac1).
  await expect.poll(async () => (await windowEvents(page)).length).toBeGreaterThan(0);
  const content = await app.evaluate(() =>
    (globalThis as unknown as Hooks).penmossDesktop.mainWindow()!.getContentSize(),
  );
  await expect
    .poll(async () => (await windowEvents(page)).at(-1)?.props)
    .toEqual({
      window: 'main',
      width: Math.round(content[0]! / 10) * 10,
      height: Math.round(content[1]! / 10) * 10,
      fullScreen: false,
      maximised: false,
    });

  // A drag of its edge, in steps: one event, 500 ms after the last (ac2).
  let before = (await windowEvents(page)).length;
  for (const width of [1100, 1120, 1140, 1160, 1183]) {
    await app.evaluate((_electron, wide) => {
      (globalThis as unknown as Hooks).penmossDesktop.mainWindow()!.setSize(wide, 700);
    }, width);
    await page.waitForTimeout(80);
  }
  await expect
    .poll(async () => (await windowEvents(page)).slice(before).map((event) => event.props.width))
    .toEqual([1180]);
  await page.waitForTimeout(1_000);
  expect((await windowEvents(page)).length).toBe(before + 1);

  // A move records nothing.
  before = (await windowEvents(page)).length;
  await mainWindow(app, 'setPosition', 40, 60);
  await mainWindow(app, 'setPosition', 80, 90);
  await page.waitForTimeout(1_500);
  expect((await windowEvents(page)).length).toBe(before);

  // Full screen on and off: each recorded as macOS says it is done, not after the settle (ac3).
  before = (await windowEvents(page)).length;
  const entered = await fullScreen(app, true);
  await expect
    .poll(async () =>
      (await windowEvents(page)).slice(before).map((event) => event.props.fullScreen),
    )
    .toContain(true);
  const on = (await windowEvents(page)).slice(before).find((event) => event.props.fullScreen)!;
  expect(on.at - entered).toBeLessThan(400);
  // On screen: the app filling the screen.
  await holdForProof(page);
  const left = await fullScreen(app, false);
  await expect
    .poll(async () => (await windowEvents(page)).slice(before).at(-1)?.props.fullScreen)
    .toBe(false);
  const off = (await windowEvents(page)).slice(before).at(-1)!;
  expect(off.at - left).toBeLessThan(400);

  // Maximised (zoomed to fill the screen): recorded once it settles, and back. Linux's xvfb (CI)
  // has no window manager to maximise a window, so there it stays as it was, and so does the record.
  const isMaximised = () =>
    app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.mainWindow()!.isMaximized());
  await mainWindow(app, 'maximize');
  if (mac) await expect.poll(isMaximised, { timeout: 10_000 }).toBe(true);
  else await page.waitForTimeout(1_500);
  if (await isMaximised()) {
    await expect
      .poll(async () => (await windowEvents(page)).at(-1)?.props.maximised, { timeout: 10_000 })
      .toBe(true);
    await mainWindow(app, 'unmaximize');
    await expect
      .poll(async () => (await windowEvents(page)).at(-1)?.props.maximised, { timeout: 10_000 })
      .toBe(false);
  } else {
    await page.waitForTimeout(1_000);
    expect((await windowEvents(page)).map((event) => event.props.maximised)).not.toContain(true);
  }

  // A note window records its own (File → Open in New Window).
  await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await page.keyboard.type(`Window ${RUN}`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('A note for its own window.');
  await expect(body(page)).toContainText('A note for its own window.');
  const [noteWindow] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ Menu }) => {
      (
        Menu.getApplicationMenu()?.getMenuItemById('note.openInNewWindow') as unknown as {
          click(): void;
        }
      ).click();
    }),
  ]);
  await expect(noteWindow.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect
    .poll(async () => (await windowEvents(page, 'note')).at(-1)?.props)
    .toMatchObject({ window: 'note', fullScreen: false, maximised: false });
  // On screen: the note in its own window.
  await holdForProof(noteWindow);
  // Its page records its layout: no sidebar in a note window, and no tabs.
  await expect
    .poll(async () =>
      (await record(page))
        .filter((event) => event.kind === 'app' && event.name === 'layout')
        .map((event) => event.props.window),
    )
    .toEqual(expect.arrayContaining(['main', 'note']));
  // Closed as its close button would, from main, so the main window is the one left.
  await app.evaluate(() => {
    for (const window of (globalThis as unknown as Hooks).penmossDesktop.noteWindows())
      window.close();
  });
  await expect
    .poll(() =>
      app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.noteWindows().length),
    )
    .toBe(0);

  // The main window back to 1280 × 720: one more main row, between the note's and Quick Capture's.
  await page.bringToFront();
  const mainRows = (await windowEvents(page)).length;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  const [backWidth = 0] = await app.evaluate(() =>
    (globalThis as unknown as Hooks).penmossDesktop.mainWindow()!.getContentSize(),
  );
  const mainWidth = Math.round(backWidth / 10) * 10;
  await expect
    .poll(async () => (await windowEvents(page)).slice(mainRows).at(-1)?.props)
    .toMatchObject({ window: 'main', width: mainWidth, fullScreen: false, maximised: false });

  // Quick Capture records its own window as it shows (ac1), at its size, and never full screen.
  await app.evaluate(() => (globalThis as unknown as Hooks).penmossDesktop.showCapture());
  const capture = await capturePage(app);
  await expect(capture.getByTestId('capture-text')).toBeVisible();
  await expect
    .poll(async () => (await windowEvents(page, 'capture')).at(-1)?.props)
    .toMatchObject({ window: 'capture', fullScreen: false, maximised: false });
  const captured = (await windowEvents(page, 'capture')).at(-1)!.props;
  expect(captured.width as number).toBeGreaterThan(0);
  expect((captured.width as number) % 10).toBe(0);
  expect((captured.height as number) % 10).toBe(0);
  // On screen: Quick Capture over the app.
  await holdForProof(capture);
  await capture.keyboard.press('Escape');

  // Sent as recorded: main's check took them, and they carry nothing about the window's place.
  await expect
    .poll(
      async () => {
        await sendNow(app);
        return fake
          .events()
          .filter((event: WireEvent) => event.kind === 'app')
          .map((event) => `${event.name} ${String(event.props.window)}`);
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toEqual(
      expect.arrayContaining([
        'window main',
        'window note',
        'window capture',
        'layout main',
        'layout note',
      ]),
    );
  for (const event of fake.events().filter((sent) => sent.kind === 'app')) {
    for (const key of Object.keys(event.props))
      expect(['x', 'y', 'display', 'scale']).not.toContain(key);
    if (event.name === 'window') {
      expect((event.props.width as number) % 10).toBe(0);
      expect((event.props.height as number) % 10).toBe(0);
    }
  }

  // Settings → Privacy → View Analytics Data: the window and layout rows, as sent, the
  // full-screen pair (ac3): on, and the off row recorded at once after it; then the newest main,
  // note and Quick Capture rows, where it ends.
  await page.bringToFront();
  await go(page, '/settings/privacy');
  await page.getByRole('link', { name: /View Analytics Data/ }).click();
  await expect(page).toHaveURL(/\/settings\/privacy\/data$/);
  const data = page.getByTestId('analytics-data');
  const rows = data.getByTestId('analytics-data-row');
  const windowRow = rows.filter({ hasText: 'fullScreen' }).first();
  const layoutRow = rows.filter({ hasText: 'themeMode' }).first();
  await expect(windowRow).toBeVisible();
  await expect(windowRow).toContainText('window');
  await expect(windowRow).toContainText('width');
  await expect(layoutRow).toBeVisible();
  await expect(layoutRow).toContainText('sidebar');
  await page.mouse.move(0, 0);
  await holdForProof(page);

  const onRow = rows.filter({ hasText: 'fullScreen: true' }).first();
  await expect(onRow).toContainText('window: main');
  const onIndex = await rows.evaluateAll((all) =>
    all.findIndex((row) => row.textContent?.includes('fullScreen: true')),
  );
  expect(onIndex).toBeGreaterThan(0);
  // Newest first: the row above it is full screen off.
  const offRow = rows.nth(onIndex - 1);
  await expect(offRow).toContainText('window: main');
  await expect(offRow).toContainText('fullScreen: false');
  await onRow.evaluate((row) => row.scrollIntoView({ block: 'center' }));
  await holdForProof(page);
  await expect(onRow).toBeInViewport();
  await expect(offRow).toBeInViewport();

  // The newest `app window` row of each window: Quick Capture's, the main window's, the note's.
  const windowRowOf = (which: string) =>
    rows
      .filter({ hasText: `window: ${which}` })
      .filter({ hasText: 'fullScreen' })
      .first();
  const captureRow = windowRowOf('capture');
  const mainRow = windowRowOf('main');
  const noteRow = windowRowOf('note');
  await expect(captureRow).toContainText('width');
  await expect(mainRow).toContainText(`width: ${mainWidth}`);
  await expect(noteRow).toContainText('width');
  await mainRow.evaluate((row) => row.scrollIntoView({ block: 'center' }));
  await page.mouse.move(0, 0);
  await holdForProof(page);
  await expect(captureRow).toBeInViewport();
  await expect(mainRow).toBeInViewport();
  await expect(noteRow).toBeInViewport();
});
