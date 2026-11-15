import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  body,
  gitNotebook,
  go,
  launch,
  mainBounds,
  removeDataDirs,
  repositoryFile,
  repositoryFiles,
  ULID,
  type Launched,
} from './support';

// A1577: closing a window (its red button, ⌘W) and quitting (⌘Q) take the windows off the
// screen at once. Their pages still store the last keystrokes and push their git notebooks
// (A825, A927), out of sight, and the windows go once that is done. Here every push takes
// seconds (a pre-receive hook that sleeps), as a push over the network does on Ryan's Mac: the
// windows used to stay on the screen for all of it.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const WINDOW = /^app:\/\/penmoss\/window\/notes\/[0-9A-HJKMNP-TV-Z]{26}$/;
const RUN = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** How long a push takes here. */
const PUSH_SECONDS = 4;
/** The longest a closing window may stay on the screen. */
const GONE_WITHIN_MS = 500;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

/** The main process's test hooks (main.ts). */
interface Hooks {
  penmossDesktop: {
    mainWindow(): Electron.BrowserWindow | null;
    noteWindows(): Electron.BrowserWindow[];
  };
}

async function start(options: Parameters<typeof launch>[0] = {}): Promise<Launched> {
  const launched = await launch(options);
  opened.push(launched);
  await mainBounds(launched.app, { x: 0, y: 0, width: 1100, height: 760 });
  return launched;
}

/** Every push to `remote` from now on takes PUSH_SECONDS. */
function slowPushes(remote: string): void {
  const hook = join(remote, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\nsleep ${PUSH_SECONDS}\nexit 0\n`);
  chmodSync(hook, 0o755);
}

async function newNote(page: Page, title: string, text: string): Promise<string> {
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(body(page)).toContainText(text);
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

/** The note's markdown on the remote's branch, or '' before it is there. */
function pushed(remote: string, title: string): string {
  const file = repositoryFiles(remote).find((path) => path.endsWith(`${title}.md`));
  return file ? repositoryFile(remote, file) : '';
}

/**
 * Closes the main window as its red button does (the same `close`) and says how long it stayed
 * on the screen: until it was no longer visible, or destroyed, looked at every 5 ms. It stays in
 * `closingWindow` for the test.
 */
const closeMainAndTime = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const hooks = (globalThis as unknown as Hooks).penmossDesktop;
        const window = hooks.mainWindow()!;
        (globalThis as unknown as { closingWindow: Electron.BrowserWindow }).closingWindow = window;
        const started = performance.now();
        const look = setInterval(() => {
          const gone = window.isDestroyed() || !window.isVisible();
          if (!gone && performance.now() - started < 30_000) return;
          clearInterval(look);
          resolve(Math.round(performance.now() - started));
        }, 5);
        window.close();
      }),
  );

/** The window `closeMainAndTime` closed: whether it is still on the screen, or destroyed. */
const closingWindow = (app: ElectronApplication) =>
  app.evaluate(() => {
    const window = (globalThis as unknown as { closingWindow: Electron.BrowserWindow })
      .closingWindow;
    if (window.isDestroyed()) return 'destroyed';
    return window.isVisible() ? 'visible' : 'hidden';
  });

test('closing the main window takes it off the screen at once, and its last keystrokes are pushed', async () => {
  const launched = await start();
  const { app, page } = launched;
  const { remote } = await gitNotebook(launched);
  slowPushes(remote);
  const title = `Close ${RUN}`;
  const id = await newNote(page, title, `first words ${RUN}`);
  // Typed just before the red button: no debounce has stored it yet.
  await page.keyboard.type(` and the last ${RUN}`);

  const shownFor = await closeMainAndTime(app);
  test
    .info()
    .annotations.push({ type: 'closing window on screen (ms)', description: `${shownFor}` });
  console.log(`[desktop] the closing main window stayed on the screen ${shownFor} ms`);
  expect(shownFor).toBeLessThan(GONE_WITHIN_MS);
  expect(await closingWindow(app)).not.toBe('visible');

  // While it still pushes out of sight, the Dock icon makes a new main window, which has the
  // note with every keystroke.
  const [again] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ app: electronApp }) => {
      electronApp.emit('activate', { preventDefault: () => undefined }, false);
    }),
  ]);
  await expect(again).toHaveURL(/^app:\/\/penmoss\//);
  await go(again, `/notes/${id}`);
  await expect(again.getByTestId('note-view')).toHaveAttribute('data-ready', 'true', {
    timeout: 20_000,
  });
  await expect(body(again)).toContainText(`first words ${RUN} and the last ${RUN}`);

  // The closing window's push lands, then it goes.
  await expect
    .poll(() => pushed(remote, title), { timeout: 30_000 })
    .toContain(`first words ${RUN} and the last ${RUN}`);
  await expect.poll(() => closingWindow(app), { timeout: 30_000 }).toBe('destroyed');
  expect(launched.errors).toEqual([]);
});

test('quitting takes every window off the screen at once, and both windows’ keystrokes are kept', async () => {
  const launched = await start();
  const { app, page } = launched;
  const { remote } = await gitNotebook(launched);
  slowPushes(remote);
  const mainTitle = `Quit main ${RUN}`;
  const mainId = await newNote(page, mainTitle, `in the main window ${RUN}`);
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  const noteTitle = `Quit note ${RUN}`;
  const noteId = await newNote(page, noteTitle, `in the note window ${RUN}`);
  // File → Open in New Window, then type in it too.
  const [window] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('note.openInNewWindow');
      (item as unknown as { click(): void }).click();
    }),
  ]);
  await expect(window).toHaveURL(WINDOW);
  await expect(window.getByTestId('note-title')).toHaveValue(noteTitle);
  await body(window).click();
  await window.keyboard.press(mac ? 'Meta+ArrowDown' : 'Control+End');
  await window.keyboard.type(` and typed last ${RUN}`);
  await expect(body(window)).toContainText(`and typed last ${RUN}`);
  await go(page, `/notes/${mainId}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');

  // ⌘Q: how long until no window is on the screen.
  opened.splice(opened.indexOf(launched), 1);
  const exited = app.waitForEvent('close', { timeout: 60_000 });
  const asked = Date.now();
  const shownFor = await app
    .evaluate(
      ({ app: electronApp }) =>
        new Promise<number>((resolve) => {
          const hooks = (globalThis as unknown as Hooks).penmossDesktop;
          const windows = [hooks.mainWindow()!, ...hooks.noteWindows()];
          const started = performance.now();
          // Every 5 ms: is any of them still visible?
          const look = setInterval(() => {
            const shown = windows.some((window) => !window.isDestroyed() && window.isVisible());
            if (shown && performance.now() - started < 30_000) return;
            clearInterval(look);
            resolve(Math.round(performance.now() - started));
          }, 5);
          electronApp.quit();
        }),
    )
    // The app may end before it answers: then it took until then.
    .catch(() => Date.now() - asked);
  await exited;
  test
    .info()
    .annotations.push({ type: 'windows on screen after ⌘Q (ms)', description: `${shownFor}` });
  console.log(`[desktop] after ⌘Q the windows stayed on the screen ${shownFor} ms`);
  expect(shownFor).toBeLessThan(GONE_WITHIN_MS);

  // The main window's edit pushed before the app ended; the note window's last keystrokes are
  // kept on this Mac: offline, the note has every word.
  expect(pushed(remote, mainTitle)).toContain(`in the main window ${RUN}`);
  const offline = await start({
    userData: launched.userData,
    offline: true,
    args: [`penmoss://note/${noteId}`],
  });
  await expect(offline.page).toHaveURL(`app://penmoss/notes/${noteId}`);
  await expect(offline.page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true', {
    timeout: 20_000,
  });
  await expect(body(offline.page)).toContainText(`in the note window ${RUN} and typed last ${RUN}`);
  expect(launched.errors).toEqual([]);
});
