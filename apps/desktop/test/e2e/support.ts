/**
 * Launching the Mac app under Playwright (`_electron`) (T29, T59). There is no Penmoss server:
 * notes live in git notebooks, on bare repositories on this machine (`gitNotebook`). Each launch
 * gets its own data directory unless one is passed, so a test can quit and launch again on the
 * same replica.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
// The page's `window.penmossDesktop` (types only).
import type {} from '../../../web/src/desktop/bridge';
import { refuseOnMacHost } from './host-guard';

export const DESKTOP = fileURLToPath(new URL('../..', import.meta.url));
export const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

/**
 * No network at all, from the first request: every connection goes to a
 * proxy nobody listens on (loopback included), and no name resolves.
 */
export const OFFLINE_ARGS = [
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  '--host-resolver-rules=MAP * ~NOTFOUND',
];

const dirs: string[] = [];
let sharedGitConfig: string | null = null;

/** A git config for the app's git: a committer, and no signing (written once per run). */
export function gitConfig(): string {
  if (sharedGitConfig) return sharedGitConfig;
  const file = join(mkdtempSync(join(tmpdir(), 'penmoss-gitconfig-')), 'gitconfig');
  writeFileSync(
    file,
    [
      '[user]',
      '  name = Ryan on the Mac',
      '  email = ryan@example.invalid',
      '[commit]',
      '  gpgSign = false',
      '',
    ].join('\n'),
  );
  sharedGitConfig = file;
  return file;
}

export function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'penmoss-desktop-'));
  dirs.push(dir);
  return dir;
}

/** Removes the data directories this run made (/tmp is RAM-backed on the worker). */
export function removeDataDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface Launched {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly userData: string;
  readonly errors: string[];
  /** Where the stand-in owner check reads its answer and logs its reasons (`answerChecks`). */
  readonly authDir: string;
}

export async function launch(
  options: {
    userData?: string;
    offline?: boolean;
    args?: readonly string[];
    /**
     * xvfb has no keyring, so safeStorage falls back to Linux's fixed-key basic_text backend,
     * which the app refuses (sealing.ts). Tests let this unpackaged build accept it, so a git
     * notebook's token is kept; false shows the refusal.
     */
    basicTextStorage?: boolean;
    /**
     * The Mac's window behaviours (T46, T47; A725): keep on top and the compact title bar's
     * layout, as on a Mac. The window keeps Linux's frame under xvfb.
     */
    macWindow?: boolean;
    /** More of the app's environment (another git config, T50; the fake GitHub, T57). */
    env?: Readonly<Record<string, string>>;
  } = {},
): Promise<Launched> {
  refuseOnMacHost('Launching the Mac app for a test');
  const userData = options.userData ?? dataDir();
  const authDir = dataDir();
  // Proof mode (the software factory's F7, `task proof:mac`): every window is recorded.
  const proof = process.env['PENMOSS_PROOF'] === '1';
  const app = await _electron.launch({
    ...(proof ? { recordVideo: { dir: test.info().outputPath('video') } } : {}),
    args: [DESKTOP, ...(options.offline ? OFFLINE_ARGS : []), ...(options.args ?? [])],
    env: {
      ...process.env,
      PENMOSS_USER_DATA: userData,
      // Who git notebooks commit as, isolated from this machine's own git config (T50, A853).
      PENMOSS_TEST_GIT_CONFIG: gitConfig(),
      // The Mac's owner check needs macOS: a script stands in for it, run the same way (A504).
      PENMOSS_TEST_AUTH_HELPER: join(DESKTOP, 'test', 'e2e', 'fake-owner-check.sh'),
      PENMOSS_TEST_AUTH_DIR: authDir,
      ...(options.basicTextStorage === false ? {} : { PENMOSS_TEST_BASIC_TEXT_STORAGE: '1' }),
      ...(options.macWindow ? { PENMOSS_TEST_MAC_WINDOW: '1' } : {}),
      // Search by meaning's service (T76) only where a spec asks for it (meaning.spec.ts), so no
      // launch downloads the model or indexes in this Mac's ~/.penmoss.
      PENMOSS_TEST_MEANING: 'off',
      ...options.env,
    },
  });
  const page = await mainPage(app);
  if (proof) recordOnClose(app, page);
  const errors = collectErrors(page, options.offline ?? false);
  return { app, page, userData, errors, authDir };
}

/**
 * Proof mode: when the test closes the app, attach a last screenshot of its window and, once the
 * app has gone, the window's video, under the names the factory reads from Playwright's report.
 */
function recordOnClose(app: ElectronApplication, page: Page): void {
  const info = test.info();
  const close = app.close.bind(app);
  app.close = async () => {
    const shot = info.outputPath('screenshot.png');
    if (!page.isClosed()) {
      await page.screenshot({ path: shot }).catch(() => undefined);
      await info
        .attach('screenshot', { path: shot, contentType: 'image/png' })
        .catch(() => undefined);
    }
    const video = page.video();
    await close();
    const path = await video?.path().catch(() => undefined);
    if (path) await info.attach('video', { path, contentType: 'video/webm' });
  };
}

/** How the stand-in owner check answers from now on: as the owner confirming, or not. */
export function answerChecks(
  { authDir }: Pick<Launched, 'authDir'>,
  answer: 'confirm' | 'refuse' | 'unavailable',
): void {
  writeFileSync(join(authDir, 'answer'), { confirm: '0', refuse: '1', unavailable: '2' }[answer]);
}

/** The reasons the owner check was asked with, in order (macOS shows “Penmoss is trying to …”). */
export function checksAsked({ authDir }: Pick<Launched, 'authDir'>): string[] {
  try {
    return readFileSync(join(authDir, 'asked'), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Console errors and page errors, except refused requests while offline. */
export function collectErrors(page: Page, offline: boolean): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (offline && /net::|WebSocket|Failed to fetch|ERR_/.test(message.text())) return;
    // Chromium's "Failed to load resource" names no address: add it, so a failure says which
    // request it was (T39 pass 3).
    const at = message.location().url;
    errors.push(
      /^Failed to load resource/.test(message.text()) && at
        ? `${message.text()} (${at})`
        : message.text(),
    );
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function windowAt(app: ElectronApplication, capture: boolean): Promise<Page> {
  // A window has no URL until it starts loading (sooner seen while recording video, F7): skip it.
  const find = () =>
    app
      .windows()
      .find(
        (page) =>
          !['', 'about:blank'].includes(page.url()) && page.url().endsWith('/capture') === capture,
      ) ?? null;
  await expect.poll(() => find() !== null, { timeout: 20_000 }).toBe(true);
  return find()!;
}

export const mainPage = (app: ElectronApplication) => windowAt(app, false);
export const capturePage = (app: ElectronApplication) => windowAt(app, true);

/** Stands in for the browser: links the app opens are recorded (`openedUrls`), not opened. */
export async function stubBrowser(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { openedUrls: opened });
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
  });
}

/** What the app has opened in the (stubbed) browser so far. */
export const openedUrls = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => [...(globalThis as unknown as { openedUrls: string[] }).openedUrls]);

/** The main process's test hooks (main.ts, `penmossDesktop`). */
interface MainHooks {
  penmossDesktop: { mainWindow(): Electron.BrowserWindow | null };
}

/**
 * Runs `code` in the main window's page as a page script would, with or
 * without a user gesture behind it (`executeJavaScript`). The main window is
 * found through the main process, not by title: pages set their own titles.
 */
export function runInMainPage(
  app: ElectronApplication,
  code: string,
  gesture: boolean,
): Promise<unknown> {
  return app.evaluate(
    (_electron, [script, withGesture]) =>
      (globalThis as unknown as MainHooks).penmossDesktop
        .mainWindow()!
        .webContents.executeJavaScript(script, withGesture) as Promise<unknown>,
    [code, gesture] as const,
  );
}

/**
 * The main window's bounds (or sets them). Set only once the app has shown the window: it opens
 * hidden and shows on `ready-to-show`, and macOS fits a window to its screen as it first shows, so
 * bounds set before then could be undone (on the test VM's old 1024 × 768 screen, 1280 wide went
 * back to 1024 about half the time, and the note's column was narrower than the test expected).
 * A size the screen cannot hold fails here, not later as a narrower layout.
 */
export async function mainBounds(
  app: ElectronApplication,
  set?: { x: number; y: number; width: number; height: number },
): Promise<Electron.Rectangle> {
  const { bounds, workArea } = await app.evaluate(async ({ screen }, wanted) => {
    const window = (globalThis as unknown as MainHooks).penmossDesktop.mainWindow()!;
    if (wanted) {
      if (!window.isVisible())
        await new Promise<void>((shown) => window.once('show', () => shown()));
      window.setBounds(wanted);
    }
    const bounds = window.getBounds();
    return { bounds, workArea: screen.getDisplayMatching(bounds).workArea };
  }, set);
  // The position may move below the menu bar; the size must be what was asked for.
  if (set && (bounds.width !== set.width || bounds.height !== set.height)) {
    throw new Error(
      `The main window is ${bounds.width} × ${bounds.height}, not the ${set.width} × ${set.height} ` +
        `asked for: its screen's work area is ${workArea.width} × ${workArea.height} ` +
        '(the test VM: PENMOSS_VM_DISPLAY, docs/ci.md §8).',
    );
  }
  return bounds;
}

export const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

/** Goes to a path inside the app, as a link does (no reload). */
export const go = (page: Page, path: string) =>
  page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);

/** A bare repository on this machine, standing in for a private GitHub repository. */
export function bareRepository(): string {
  const remote = join(dataDir(), 'notes.git');
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  return remote;
}

export interface GitNotebook {
  readonly name: string;
  readonly remote: string;
}

/**
 * Makes a git notebook on a new bare repository, as Ryan does in Settings → Git Notebooks (one on
 * this machine syncs without a check, D51), and waits until it has synced; then goes back to the
 * app's start. The notes the test makes are in it (T59: there is no other source).
 */
export async function gitNotebook(
  launched: Pick<Launched, 'page' | 'authDir'>,
  name = 'Notes',
): Promise<GitNotebook> {
  const { page } = launched;
  const remote = bareRepository();
  // With no notebook yet the app shows only the first-run screen and its Add form (T59, A1030);
  // after that, the form is in Settings.
  await go(page, '/');
  const firstRun = page.getByTestId('first-run');
  await expect(firstRun.or(page.locator('#app-sidebar')).first()).toBeVisible({ timeout: 30_000 });
  const first = await firstRun.isVisible();
  if (!first) await go(page, '/settings/git-notebooks');
  const settings = first ? firstRun : page.getByTestId('git-notebooks-settings');
  await expect(settings).toBeVisible();
  // Under the list, the form opens from Add a Git Notebook… (A1098); on the first run, from its
  // welcome's "Start a new notebook" (T69, A1146).
  if (!first) await settings.getByTestId('git-add-open').click();
  else await settings.getByTestId('first-run-new').click();
  const form = settings.getByTestId('git-add');
  await form.getByTestId('git-add-remote').fill(`file://${remote}`);
  await form.getByTestId('git-add-name').fill(name);
  await form.locator('button[type="submit"]').click();
  if (first) await expect(notebookSection(page, name)).toBeVisible({ timeout: 30_000 });
  else
    await expect(settings.getByTestId('git-add-message')).toContainText(
      `Made the notebook “${name}”`,
    );
  await notebookSynced(page, name);
  await go(page, '/');
  await expect(notebookSection(page, name)).toBeVisible();
  return { name, remote };
}

/** The notebook's section in the sidebar. */
export const notebookSection = (page: Page, name: string) =>
  page.getByTestId('source-section').filter({
    has: page.locator('.sb-section-name', { hasText: name }),
  });

/** Waits until the notebook's row in Settings → Git Notebooks says it has synced. */
export async function notebookSynced(page: Page, name: string): Promise<void> {
  const back = page.url();
  if (!back.endsWith('/settings/git-notebooks')) await go(page, '/settings/git-notebooks');
  const row = page.getByTestId('git-notebook-row').filter({ hasText: name });
  await expect(row).toHaveAttribute('data-phase', 'synced', { timeout: 30_000 });
  if (!back.endsWith('/settings/git-notebooks')) await go(page, new URL(back).pathname);
}

/** The rendered markdown files on a bare repository's main branch. */
export function repositoryFiles(remote: string): string[] {
  try {
    return execFileSync('git', ['-C', remote, 'ls-tree', '-r', '--name-only', 'main'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** A file on a bare repository's main branch. */
export const repositoryFile = (remote: string, path: string) =>
  execFileSync('git', ['-C', remote, 'show', `main:${path}`], { encoding: 'utf8' });
