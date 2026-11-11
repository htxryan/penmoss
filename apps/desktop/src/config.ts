/**
 * Where the Mac app's pages come from, and its settings for development and tests (T29, T59).
 *
 * Pages are the bundled web app on a scheme of the app's own (`app://penmoss/…`), so the app
 * opens with no network from its first launch. Notes live in git notebooks, which main syncs
 * with this Mac's own git (A853); there is no Penmoss server (D48, D49).
 *
 * The `PENMOSS_*` overrides exist for development and the Playwright suite; a packaged app
 * ignores them, so nothing in its environment can redirect what it sends.
 */
import { join } from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'penmoss';
export const PAGE_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const DEEP_LINK_SCHEME = 'penmoss';

export interface DesktopConfig {
  /** The bundled web app (index.html and its assets). */
  readonly webRoot: string;
  /** Overrides Electron's userData directory (tests run each launch in a fresh one). */
  readonly userData: string | null;
  /** Development tools in the View menu (unpackaged builds only). */
  readonly devTools: boolean;
  /**
   * Seal tokens with Linux's `basic_text` safeStorage backend (a fixed key) all the same: only
   * for the Playwright suite under xvfb, which has no keyring (`PENMOSS_TEST_BASIC_TEXT_STORAGE=1`,
   * unpackaged builds only).
   */
  readonly allowBasicTextStorage: boolean;
  /**
   * The Mac's owner check (T41, A504): `Contents/Resources/auth/Penmoss` when packaged,
   * `dist/native/Penmoss` in development on a Mac (build.mjs), and null elsewhere, where
   * every owner check is refused. The Playwright suite stands in for it with a script
   * (`PENMOSS_TEST_AUTH_HELPER`, unpackaged builds only).
   */
  readonly authHelper: string | null;
  /**
   * The suite's stand-in answers every owner check, Touch ID's too (main's own checks ask Touch
   * ID first where the Mac has it, T50 A855): true only with `PENMOSS_TEST_AUTH_HELPER`.
   */
  readonly testAuthHelper: boolean;
  /**
   * Extra environment for the git that git notebooks run (T50, A853): the suite isolates git's
   * own configuration with it (`PENMOSS_TEST_GIT_CONFIG`: a file for `GIT_CONFIG_GLOBAL`,
   * unpackaged builds only).
   */
  readonly gitEnv: Readonly<Record<string, string>> | null;
  /**
   * The Mac's window behaviours off a Mac (T46, T47, A725): keep on top and the compact title
   * bar's layout, for the Playwright suite under xvfb (`PENMOSS_TEST_MAC_WINDOW=1`, unpackaged
   * builds only). The window keeps Linux's frame; the page lays out as on a Mac.
   */
  readonly testMacWindow: boolean;
  /**
   * Search by meaning's service (T76): `off` does not start it, `no-download` never downloads
   * the model (`PENMOSS_TEST_MEANING`, unpackaged builds only; the Electron suite).
   */
  readonly testMeaning: 'off' | 'no-download' | null;
  /**
   * The home folder the `penmoss` command is written under (T54, A992): the suite's own
   * (`PENMOSS_TEST_HOME`, unpackaged builds only), never the person's.
   */
  readonly testHome: string | null;
  /**
   * A local fake GitHub for Send feedback and the token check (T57, A1010): the suite's
   * (`PENMOSS_TEST_GITHUB_API`, an http origin on loopback, unpackaged builds only). Otherwise
   * the main process talks to api.github.com and uploads.github.com.
   */
  readonly githubApi: string | null;
  /**
   * github.com's sign-in pages for Sign in with GitHub (T82, A1172): the suite's fake
   * (`PENMOSS_TEST_GITHUB_WEB`, an http origin on loopback, unpackaged builds only); otherwise
   * https://github.com.
   */
  readonly githubWeb: string | null;
  /**
   * Penmoss's GitHub OAuth app (T82, A1170): public, and needs no secret for the device flow.
   * Null in a build without one, which then offers no Sign in with GitHub. The suite sets its own
   * (`PENMOSS_TEST_GITHUB_CLIENT_ID`, unpackaged builds only).
   */
  readonly githubClientId: string | null;
  /**
   * The version Settings → Updates places the release notes by (PEN-108): the suite's, such as
   * `0.2.2-alpha.1185` (`PENMOSS_TEST_APP_VERSION`, unpackaged builds only); otherwise the app's.
   */
  readonly testVersion: string | null;
}

/**
 * Penmoss's OAuth app on GitHub (D63, A1173): "Penmoss", owned by htxryan, with the device flow on
 * and tokens that don't expire. A client id is public; the device flow needs no secret.
 */
export const GITHUB_CLIENT_ID: string | null = 'Ov23liU4eAFD4vcdWWOR';

/** An `http(s)` origin exactly (no path), or an error naming the variable. */
export function originOf(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value) {
    throw new Error(`${name} must be an http(s) origin such as http://127.0.0.1:8791`);
  }
  return url.origin;
}

export function desktopConfig(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly packaged: boolean;
  /** The app's directory: apps/desktop, or app.asar when packaged. */
  readonly appPath: string;
  /** `process.resourcesPath`: the app's Contents/Resources when packaged. */
  readonly resourcesPath?: string;
  readonly platform?: NodeJS.Platform;
}): DesktopConfig {
  const { env, packaged } = options;
  const dev = (name: string): string | undefined => (packaged ? undefined : env[name] || undefined);
  return {
    // Inside app.asar when packaged, so the bundle is covered by the asar integrity check (A225).
    webRoot: dev('PENMOSS_WEB_ROOT') ?? join(options.appPath, 'dist', 'web'),
    userData: dev('PENMOSS_USER_DATA') ?? null,
    devTools: !packaged,
    allowBasicTextStorage: dev('PENMOSS_TEST_BASIC_TEXT_STORAGE') === '1',
    authHelper: authHelperPath(options, dev('PENMOSS_TEST_AUTH_HELPER')),
    testAuthHelper: dev('PENMOSS_TEST_AUTH_HELPER') !== undefined,
    gitEnv: ((file) => (file ? { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' } : null))(
      dev('PENMOSS_TEST_GIT_CONFIG'),
    ),
    testMacWindow: dev('PENMOSS_TEST_MAC_WINDOW') === '1',
    testMeaning: ((value) => (value === 'off' || value === 'no-download' ? value : null))(
      dev('PENMOSS_TEST_MEANING'),
    ),
    testHome: dev('PENMOSS_TEST_HOME') ?? null,
    githubApi: loopbackOrigin(dev('PENMOSS_TEST_GITHUB_API'), 'PENMOSS_TEST_GITHUB_API'),
    githubWeb: loopbackOrigin(dev('PENMOSS_TEST_GITHUB_WEB'), 'PENMOSS_TEST_GITHUB_WEB'),
    // A suite with a stand-in GitHub API signs in only at its own stand-in, never github.com.
    githubClientId:
      dev('PENMOSS_TEST_GITHUB_CLIENT_ID') ??
      (dev('PENMOSS_TEST_GITHUB_API') ? null : GITHUB_CLIENT_ID),
    testVersion: dev('PENMOSS_TEST_APP_VERSION') ?? null,
  };
}

/** An http origin on this machine (127.0.0.1, localhost, [::1]), or an error; null for none. */
function loopbackOrigin(value: string | undefined, name: string): string | null {
  if (!value) return null;
  const origin = originOf(value, name);
  const host = new URL(origin).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error(`${name} must be on this machine (127.0.0.1, localhost or [::1])`);
  }
  return origin;
}

function authHelperPath(
  options: {
    readonly packaged: boolean;
    readonly appPath: string;
    readonly resourcesPath?: string;
    readonly platform?: NodeJS.Platform;
  },
  testHelper: string | undefined,
): string | null {
  if (testHelper) return testHelper;
  if ((options.platform ?? process.platform) !== 'darwin') return null;
  if (options.packaged) {
    return options.resourcesPath ? join(options.resourcesPath, 'auth', 'Penmoss') : null;
  }
  return join(options.appPath, 'dist', 'native', 'Penmoss');
}
