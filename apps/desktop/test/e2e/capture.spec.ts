import { execFileSync } from 'node:child_process';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  body,
  capturePage,
  gitNotebook,
  launch,
  removeDataDirs,
  repositoryFile,
  repositoryFiles,
  runInMainPage,
  ULID,
  type Launched,
} from './support';
// The page's `window.penmossDesktop` (types only).
import type {} from '../../../web/src/desktop/bridge';

// T30: quick capture. The system-wide hotkey shows a small capture window over any app;
// ⌘Enter (Ctrl+Enter here) saves to today's note under ## Captures, or to a new note in
// Inbox, through the local replica, so it works offline and syncs later. Notes live in a git
// notebook on a bare repository here (T59).

const mac = process.platform === 'darwin';
const SAVE = mac ? 'Meta+Enter' : 'Control+Enter';
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

async function start(options: Parameters<typeof launch>[0] = {}): Promise<Launched> {
  const launched = await launch(options);
  opened.push(launched);
  return launched;
}

async function quit(launched: Launched): Promise<void> {
  opened.splice(opened.indexOf(launched), 1);
  await launched.app.close();
}

interface MainHooks {
  penmossDesktop: {
    showCapture(): void;
    hotkey(): { accelerator: string; registered: boolean; certain: boolean };
    captureWindow(): { isVisible(): boolean; emit(event: string): void } | null;
    mainWindow(): { focus(): void; hide(): void; isVisible(): boolean } | null;
    showFirst(): void;
  };
}

const hooks = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as MainHooks).penmossDesktop.hotkey());

const captureVisible = (app: ElectronApplication) =>
  app.evaluate(
    () => (globalThis as unknown as MainHooks).penmossDesktop.captureWindow()?.isVisible() ?? false,
  );

/** xdotool can press the real hotkey on the X display (xvfb); without it, the hook stands in. */
function hasXdotool(): boolean {
  try {
    execFileSync('xdotool', ['version'], { stdio: 'ignore' });
    return Boolean(process.env.DISPLAY);
  } catch {
    return false;
  }
}

/** Presses the capture hotkey (or shows the window as the hotkey does) and waits for it. */
async function openCapture(app: ElectronApplication): Promise<Page> {
  const { accelerator, registered } = await hooks(app);
  if (registered && !mac && hasXdotool()) {
    // xdotool's names: ctrl, alt, shift; letters and space in lower case, F-keys as F9.
    const names: Record<string, string> = {
      Control: 'ctrl',
      Alt: 'alt',
      Shift: 'shift',
      Space: 'space',
    };
    const keys = accelerator
      .split('+')
      .map((part) => names[part] ?? (part.length === 1 ? part.toLowerCase() : part))
      .join('+');
    execFileSync('xdotool', ['key', keys]);
  } else {
    await app.evaluate(() => (globalThis as unknown as MainHooks).penmossDesktop.showCapture());
  }
  try {
    await expect.poll(() => captureVisible(app)).toBe(true);
  } catch (error) {
    // T39 pass 3: this has failed now and then at the first press after a relaunch and has not
    // been reproduced since; say what the app knew, so the next failure tells why.
    const known = await app.evaluate(() => {
      const desktop = (globalThis as unknown as MainHooks).penmossDesktop;
      const window = desktop.captureWindow() as unknown as {
        isVisible(): boolean;
        webContents: { isLoading(): boolean; getURL(): string };
      } | null;
      return {
        hotkey: desktop.hotkey(),
        window: window
          ? {
              visible: window.isVisible(),
              loading: window.webContents.isLoading(),
              url: window.webContents.getURL(),
            }
          : null,
      };
    });
    throw new Error(`The capture window did not show: ${JSON.stringify(known)}`, { cause: error });
  }
  const page = await capturePage(app);
  await expect(page.getByTestId('capture-text')).toBeFocused();
  return page;
}

/** The file on the repository's branch whose name ends with `name`, once it is there. */
async function fileNamed(remote: string, name: string): Promise<string> {
  const find = () => repositoryFiles(remote).find((path) => path.endsWith(name)) ?? null;
  await expect.poll(find, { timeout: 30_000 }).not.toBeNull();
  return find()!;
}

/** Saves with ⌘Enter and returns how long until the window was gone (the save had landed). */
async function save(app: ElectronApplication, page: Page): Promise<number> {
  const started = Date.now();
  await page.keyboard.press(SAVE);
  await expect.poll(() => captureVisible(app), { intervals: [20] }).toBe(false);
  return Date.now() - started;
}

test('the hotkey’s window captures to today’s note under ## Captures, and the repository gets it', async () => {
  const tag = `c${Date.now().toString(36)}`;
  const launched = await start();
  const { app, page } = launched;
  expect(await hooks(app)).toEqual({
    accelerator: mac ? 'Control+Alt+Command+N' : 'Control+Shift+Space',
    registered: true,
    // macOS cannot tell whether another app takes the keys first; elsewhere it can.
    certain: !mac,
  });
  const { remote } = await gitNotebook(launched);

  const capture = await openCapture(app);
  await capture.getByRole('radio', { name: 'Today’s Note' }).check();
  await capture.getByTestId('capture-text').fill(`First thought ${tag}`);
  const firstMs = await save(app, capture);
  expect(firstMs).toBeLessThan(2000);

  // Again: the field is empty and focused, and the second capture joins the same section.
  // Today's Note chosen again, as the test chose it the first time.
  const again = await openCapture(app);
  await expect(again.getByTestId('capture-text')).toHaveValue('');
  await again.getByRole('radio', { name: 'Today’s Note' }).check();
  await again.getByTestId('capture-text').fill(`Second thought ${tag}`);
  const secondMs = await save(app, again);
  expect(secondMs).toBeLessThan(2000);
  console.log(`[desktop] capture saves: ${firstMs} ms, ${secondMs} ms`);
  test.info().annotations.push({
    type: 'capture save (ms)',
    description: `${firstMs}, ${secondMs}`,
  });

  // Escape closes it without saving.
  const third = await openCapture(app);
  await third.getByTestId('capture-text').fill(`Never saved ${tag}`);
  await third.keyboard.press('Escape');
  await expect.poll(() => captureVisible(app)).toBe(false);

  // Today's note in the main window shows both under one ## Captures heading.
  await page.bringToFront();
  await page.keyboard.press('ControlOrMeta+KeyD');
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(body(page)).toContainText(`Second thought ${tag}`);
  await expect(body(page).locator('h2', { hasText: /^Captures$/ })).toHaveCount(1);
  await expect(body(page)).not.toContainText(`Never saved ${tag}`);
  const day = await page.getByTestId('note-title').inputValue();
  expect(launched.errors).toEqual([]);

  // Quitting pushes them (A825), so every other device gets them on its next sync.
  await quit(launched);
  const daily = await fileNamed(remote, `/${day}.md`);
  const markdown = repositoryFile(remote, daily);
  expect(markdown).toMatch(
    new RegExp(`## Captures[\\s\\S]*\\*\\*\\d\\d:\\d\\d\\*\\* First thought ${tag}`),
  );
  expect(markdown.match(/^## Captures$/gm)).toHaveLength(1);
  expect(markdown.indexOf(`First thought ${tag}`)).toBeLessThan(
    markdown.indexOf(`Second thought ${tag}`),
  );
});

test('captures to a new Inbox note offline and syncs it later; the default is Settings’ (A947)', async () => {
  const tag = `i${Date.now().toString(36)}`;
  const first = await start();
  const { remote } = await gitNotebook(first);
  // Settings → Daily Notes chooses the default (A947; kept in the notebook's device settings,
  // A827, so the app's dialog starts there too).
  const chooseDefault = async (page: Page, name: string) => {
    await page.evaluate(() => window.history.pushState(null, '', '/settings/journal'));
    await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
    const quick = page.getByTestId('capture-default-setting');
    await quick.getByText(name, { exact: true }).click();
    await expect(quick.getByRole('radio', { name })).toBeChecked();
    // Back to the notes.
    await page.evaluate(() => window.history.pushState(null, '', '/'));
    await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  };
  await chooseDefault(first.page, 'Today’s Note');
  await quit(first);

  const offline = await start({ userData: first.userData, offline: true });
  const capture = await openCapture(offline.app);
  await capture.getByRole('radio', { name: 'New Note in Inbox' }).check();
  await capture.getByTestId('capture-text').fill(`Offline idea ${tag}\nA shed with a green roof`);
  expect(await save(offline.app, capture)).toBeLessThan(2000);
  // It is in the main window's tree at once, in Inbox, from the shared local replica.
  const tree = offline.page.getByRole('tree', { name: 'Folders and notes' });
  const inbox = tree.getByRole('treeitem', { name: 'Inbox', exact: true });
  await expect(inbox).toBeVisible();
  if ((await inbox.getAttribute('aria-expanded')) !== 'true') {
    await inbox.focus();
    await offline.page.keyboard.press('ArrowRight');
  }
  // Filed under Inbox: the row after it, one level down (the tree is flat in the DOM).
  await expect(tree.getByRole('treeitem', { name: `Offline idea ${tag}`, level: 2 })).toBeVisible();
  // The page has no network, but main's git does: quitting pushes it, filed in Inbox.
  await quit(offline);
  expect(await fileNamed(remote, `Offline idea ${tag}.md`)).toMatch(/^Inbox\//);

  const online = await start({ userData: first.userData });
  // The form's choice was for that capture only (T51 item 19, A947): the next starts on the
  // default, Today's Note.
  const next = await openCapture(online.app);
  await expect(next.getByRole('radio', { name: 'Today’s Note' })).toBeChecked();
  await next.keyboard.press('Escape');
  await expect.poll(() => captureVisible(online.app)).toBe(false);
  const { page } = online;
  await chooseDefault(page, 'New Note in Inbox');
  const defaulted = await openCapture(online.app);
  await expect(defaulted.getByRole('radio', { name: 'New Note in Inbox' })).toBeChecked();
  await defaulted.getByRole('radio', { name: 'Today’s Note' }).check();
  await defaulted.getByTestId('capture-text').fill(`Back to today ${tag}`);
  expect(await save(online.app, defaulted)).toBeLessThan(2000);
  // Still the default the next time.
  const after = await openCapture(online.app);
  await expect(after.getByRole('radio', { name: 'New Note in Inbox' })).toBeChecked();
  await after.keyboard.press('Escape');
  await expect.poll(() => captureVisible(online.app)).toBe(false);
  expect(online.errors).toEqual([]);
});

// Review of PR #100, S3 (A541), T50 (A853): the capture window's bridge only lists git notebooks,
// to file a capture in the Journal notebook; it cannot change one. T59: no window has a session
// or admin requests any more, as there is no server.
test('the capture window lists git notebooks and cannot change them; no window has a session', async () => {
  const launched = await start();
  await gitNotebook(launched);
  const capture = await openCapture(launched.app);
  const bridge = () => {
    const desktop = window.penmossDesktop as unknown as Record<string, unknown>;
    return {
      admin: typeof desktop['admin'],
      session: typeof desktop['session'],
      git: Object.keys((desktop['git'] as object | undefined) ?? {}).sort(),
    };
  };
  expect(await capture.evaluate(bridge)).toEqual({
    admin: 'undefined',
    session: 'undefined',
    git: ['list', 'onChange'],
  });
  expect(await launched.page.evaluate(bridge)).toMatchObject({
    admin: 'undefined',
    session: 'undefined',
  });
});

test('the app’s Quick capture command opens the same form in the window', async () => {
  const tag = `q${Date.now().toString(36)}`;
  const launched = await start();
  const { page } = launched;
  await gitNotebook(launched);
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+KeyK');
  const dialog = page.getByTestId('capture-dialog');
  await expect(dialog.getByTestId('capture-text')).toBeFocused();
  await dialog.getByRole('radio', { name: 'Today’s Note' }).check();
  await dialog.getByTestId('capture-text').fill(`From the command ${tag}`);
  await page.keyboard.press(SAVE);
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+KeyD');
  await expect(body(page)).toContainText(`From the command ${tag}`);
  expect(launched.errors).toEqual([]);
});

test('the capture window fits its window: no scrollbar, however long the text (T39)', async () => {
  const launched = await start();
  await gitNotebook(launched);
  const capture = await openCapture(launched.app);
  const overflow = () =>
    capture.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return {
        down: root.scrollHeight - root.clientHeight,
        across: root.scrollWidth - root.clientWidth,
      };
    });
  expect(await overflow()).toEqual({ down: 0, across: 0 });
  // A long capture scrolls inside its text field; the window itself never scrolls.
  await capture.getByTestId('capture-text').fill('A long capture line\n'.repeat(20));
  expect(await overflow()).toEqual({ down: 0, across: 0 });
  await expect(capture.getByRole('button', { name: /^Save/ })).toBeInViewport();
  await capture.keyboard.press('Escape');
  expect(launched.errors).toEqual([]);
});

test('a capture opened while the app starts keeps its focus when the main window shows', async () => {
  const launched = await start();
  const { app } = launched;
  await gitNotebook(launched);
  // The order a slow start can give (A904): the hotkey's window first, then the main window's
  // first show. Showing it as usual took the focus, and the capture window hid.
  await app.evaluate(() =>
    (globalThis as unknown as MainHooks).penmossDesktop.mainWindow()?.hide(),
  );
  const capture = await openCapture(app);
  await app.evaluate(() => (globalThis as unknown as MainHooks).penmossDesktop.showFirst());
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as unknown as MainHooks).penmossDesktop.mainWindow()?.isVisible() ?? false,
      ),
    )
    .toBe(true);
  // Long enough for a focus change to have hidden it.
  await capture.waitForTimeout(500);
  expect(await captureVisible(app)).toBe(true);
  await expect(capture.getByTestId('capture-text')).toBeFocused();
  await capture.keyboard.press('Escape');
  await expect.poll(() => captureVisible(app)).toBe(false);
  expect(launched.errors).toEqual([]);
});

test('keeps the draft when the window loses focus, until it is saved or cancelled', async () => {
  const tag = `b${Date.now().toString(36)}`;
  const launched = await start();
  const { app } = launched;
  await gitNotebook(launched);
  const capture = await openCapture(app);
  await capture.getByRole('radio', { name: 'New Note in Inbox' }).check();
  await capture.getByTestId('capture-text').fill(`Half a thought ${tag}`);
  // Focus goes elsewhere (a notification, a click in another window): the window hides.
  await app.evaluate(() => {
    const hooks = (globalThis as unknown as MainHooks).penmossDesktop;
    hooks.mainWindow()?.focus();
    // Without a window manager (xvfb) focus moves no window: send the blur it would get.
    if (hooks.captureWindow()?.isVisible()) hooks.captureWindow()?.emit('blur');
  });
  await expect.poll(() => captureVisible(app)).toBe(false);
  // Shown again: the text and its destination are still there, and the field has focus.
  const again = await openCapture(app);
  await expect(again.getByTestId('capture-text')).toHaveValue(`Half a thought ${tag}`);
  await expect(again.getByRole('radio', { name: 'New Note in Inbox' })).toBeChecked();
  // Escape cancels it: the next time the field is empty.
  await again.keyboard.press('Escape');
  await expect.poll(() => captureVisible(app)).toBe(false);
  const third = await openCapture(app);
  await expect(third.getByTestId('capture-text')).toHaveValue('');
  expect(launched.errors).toEqual([]);
});

test('a settings change made offline in the main window counts in the next capture', async () => {
  const tag = `z${Date.now().toString(36)}`;
  const first = await start();
  await gitNotebook(first);
  await quit(first);

  // Offline, with both windows open: the change reaches the capture window through this Mac.
  const offline = await start({ userData: first.userData, offline: true });
  const { app, page } = offline;
  const capture = await openCapture(app);
  await capture.keyboard.press('Escape');
  await expect.poll(() => captureVisible(app)).toBe(false);

  // A time zone where today is another day than in the default one (America/Chicago).
  const zone = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find(
    (candidate) =>
      new Date().toLocaleDateString('en-CA', { timeZone: candidate }) !==
      new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }),
  )!;
  const day = new Date().toLocaleDateString('en-CA', { timeZone: zone });
  await page.evaluate(() => window.history.pushState(null, '', '/settings/journal'));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  const settings = page.getByTestId('journal-settings');
  await settings.getByLabel('Time zone').selectOption(zone);
  await expect(settings).toContainText(`Today is ${day} in ${zone}`);

  // At once, from the hotkey: the capture goes to that day's note.
  const next = await openCapture(app);
  await next.getByRole('radio', { name: 'Today’s Note' }).check();
  await next.getByTestId('capture-text').fill(`Across the date line ${tag}`);
  expect(await save(app, next)).toBeLessThan(2000);
  // Back to the notes, then Today (in the new time zone) has the capture.
  await page.bringToFront();
  await page.evaluate(() => window.history.pushState(null, '', '/'));
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+KeyD');
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(day);
  await expect(body(page)).toContainText(`Across the date line ${tag}`);
  expect(offline.errors).toEqual([]);
});

test('the capture hotkey changes only from Settings, and only to one A90 allows', async () => {
  const launched = await start();
  const { app, page } = launched;
  await gitNotebook(launched);
  // Adding it took clicks, which count as a person's for a few seconds (transient activation).
  await expect
    .poll(() => runInMainPage(app, 'navigator.userActivation.isActive', false), {
      timeout: 15_000,
    })
    .toBe(false);
  const original = (await hooks(app)).accelerator;
  // Waited for from the main process: Playwright's own page calls count as user gestures.
  const shows = (selector: string) =>
    expect
      .poll(() => runInMainPage(app, `document.querySelector('${selector}') !== null`, false))
      .toBe(true);
  await shows('button[data-command="note.new"]');
  // To Settings → Keyboard shortcuts as a script would, with no key press or click yet.
  await runInMainPage(
    app,
    `history.pushState(null, '', '/settings/shortcuts'); dispatchEvent(new PopStateEvent('popstate'))`,
    false,
  );
  await shows('[data-testid="capture-hotkey"]');
  expect(
    await runInMainPage(app, 'navigator.userActivation.isActive', false),
    'no key press or click yet',
  ).toBe(false);
  // A script in the page, with no key press or click behind it, cannot change it, even here.
  const scripted = await runInMainPage(
    app,
    'window.penmossDesktop.capture.setHotkey("Control+Shift+F10")',
    false,
  );
  expect(scripted).toMatchObject({ accelerator: original, error: /Settings/ });
  expect((await hooks(app)).accelerator).toBe(original);

  const form = page.getByTestId('capture-hotkey');
  const field = form.getByLabel('Quick capture from any app');
  await expect(field).toHaveValue(original);
  // Redo in every app (⌘⇧Z on a Mac, where ⌃⇧Z is free; Ctrl+Shift+Z elsewhere): refused.
  await field.fill(mac ? 'Command+Shift+Z' : 'Control+Shift+Z');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('status')).toContainText('Penmoss keeps it free');
  expect((await hooks(app)).accelerator).toBe(original);
  // A free one: taken.
  await field.fill('Control+Shift+F9');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('status')).toContainText('Control+Shift+F9');
  expect(await hooks(app)).toMatchObject({ accelerator: 'Control+Shift+F9', registered: true });

  // Nor can the capture window, gesture or not.
  const capture = await openCapture(app);
  expect(
    await capture.evaluate(() => window.penmossDesktop!.capture.setHotkey('Control+Shift+F11')),
  ).toBeNull();
  expect((await hooks(app)).accelerator).toBe('Control+Shift+F9');
  expect(launched.errors).toEqual([]);
});
