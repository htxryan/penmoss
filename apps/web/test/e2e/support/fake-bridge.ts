/**
 * `window.penmossDesktop` for the web suite (T59): the Mac app's preload API, as small as the
 * specs need. Git calls go to the test's `GitHost` (Node) through the `__penmossGit` binding;
 * everything else is answered in the page:
 *
 * - `stored` / `onStoreChanged`: a BroadcastChannel between this context's pages, as main tells
 *   every other window (A711).
 * - `window.open` follows the Mac's window rules (A712): note windows open with no opener, other
 *   app paths go to the main window's `onOpenPath`.
 * - `menu`, `theme`, `capture`, `onBeforeClose`: kept, never fired by main (the suite has no
 *   native menu; keys reach the page).
 * - `clipboard.write`: the browser's clipboard, as main writes the system's.
 * - `feedback.file` and `githubToken`: main's filing with the person's GitHub token (A1010),
 *   through the binding too; `feedback.capture` takes no picture of the window (null).
 * - `updates`: main's Auto-Update (A1112) over a stand-in feed the spec sets.
 * - Local agents and the `penmoss` command: none on this stand-in Mac.
 *
 * This function is serialized into each page (`addInitScript`): it must not close over anything.
 * Bytes cross the binding as base64 (`{ __bytes }`), both ways.
 */
import type { MenuCommandEvent, PenmossDesktop } from '../../../src/desktop/bridge';

export const GIT_BINDING = '__penmossGit';
/** The page's hook the host calls when the notebook list changed. */
export const GIT_CHANGED = '__penmossGitChanged';
/** The page's hook the host calls when the GitHub token was saved or removed. */
export const GITHUB_TOKEN_CHANGED = '__penmossGitHubTokenChanged';
/** The page's hook the host calls with Auto-Update's new state (A1112). */
export const UPDATES_CHANGED = '__penmossUpdatesChanged';
/** The page's hook the host calls when a Sign in with GitHub moved on (T82). */
export const SIGN_IN_CHANGED = '__penmossSignInChanged';
/** The page's hook the host calls with search by meaning's new status (T77). */
export const MEANING_CHANGED = '__penmossMeaningChanged';

/** What the page's fake keeps for specs to look at. */
export interface FakeBridgeState {
  menus: unknown;
  theme: unknown;
}

declare global {
  interface Window {
    __penmossGit?: (method: string, args: unknown) => Promise<unknown>;
    __penmossGitChanged?: () => void;
    __penmossGitHubTokenChanged?: () => void;
    __penmossUpdatesChanged?: (state: unknown) => void;
    __penmossSignInChanged?: (state: unknown) => void;
    __penmossMeaningChanged?: (status: unknown) => void;
    __penmossFake?: FakeBridgeState;
  }
}

export function installFakeBridge(config: {
  readonly platform: string;
  /** Search by meaning's service (T77): a Mac app from T76 on, with the model here. */
  readonly meaning?: boolean;
  /**
   * The main and note windows' `macWindow` (T46, T47): Keep on Top's pin, kept in the page, and
   * the compact title bar, so `<html data-titlebar="compact">` is set as in the Mac app.
   */
  readonly macWindow?: boolean;
}): void {
  const toBase64 = (bytes: Uint8Array): string => {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  };
  const fromBase64 = (text: string): Uint8Array => {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  };
  const encode = (value: unknown): unknown => {
    if (value instanceof Uint8Array) return { __bytes: toBase64(value) };
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
    }
    return value;
  };
  const decode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === 'object') {
      const bytes = (value as { __bytes?: unknown }).__bytes;
      if (typeof bytes === 'string') return fromBase64(bytes);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
    }
    return value;
  };
  const host = async (method: string, ...args: unknown[]): Promise<never> => {
    const binding = window.__penmossGit;
    if (!binding) throw new Error('The git host is not connected.');
    return decode(await binding(method, encode(args))) as never;
  };

  const gitListeners = new Set<() => void>();
  window.__penmossGitChanged = () => {
    for (const listener of gitListeners) listener();
  };
  const tokenListeners = new Set<() => void>();
  window.__penmossGitHubTokenChanged = () => {
    for (const listener of tokenListeners) listener();
  };
  const updateListeners = new Set<(state: unknown) => void>();
  window.__penmossUpdatesChanged = (state) => {
    for (const listener of updateListeners) listener(state);
  };
  const signInListeners = new Set<(state: unknown) => void>();
  window.__penmossSignInChanged = (state) => {
    for (const listener of signInListeners) listener(state);
  };
  const meaningListeners = new Set<(status: unknown) => void>();
  window.__penmossMeaningChanged = (status) => {
    for (const listener of meaningListeners) listener(status);
  };
  const listen = <T>(set: Set<T>, listener: T) => {
    set.add(listener);
    return () => void set.delete(listener);
  };

  const state: FakeBridgeState = { menus: null, theme: null };
  window.__penmossFake = state;
  /** This window's pin (`macWindow`), as main keeps it per window. */
  let macState = { keepOnTop: false, fullScreen: false };
  const macListeners = new Set<(state: typeof macState) => void>();
  const menuListeners = new Set<(event: MenuCommandEvent) => void>();
  const storeListeners = new Set<(ids?: readonly string[]) => void>();
  const store =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('penmoss:fake-main');
  store?.addEventListener('message', (event: MessageEvent<{ ids?: readonly string[] | null }>) => {
    const ids = event.data.ids ?? undefined;
    for (const listener of storeListeners) listener(ids);
  });
  const none = {
    ok: false as const,
    error: { code: 'unavailable', message: 'Not on this stand-in Mac.' },
  };

  const path = window.location.pathname;
  const kind = path.startsWith('/window/') ? 'note' : path === '/capture' ? 'capture' : 'main';

  // The Mac's window rules (A712), which its main process applies and a browser does not: the
  // page's `window.open` returns no window; a note window's path opens a window of its own with
  // no opener, and any other app path is shown in the main window (main sends it as an open
  // path, `onOpenPath`).
  const openPaths = new Set<(path: string) => void>();
  const opener =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('penmoss:fake-main-open');
  if (kind === 'main') {
    opener?.addEventListener('message', (event: MessageEvent<{ path?: unknown }>) => {
      const next = event.data.path;
      if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return;
      for (const listener of openPaths) listener(next);
    });
  }
  const open = window.open.bind(window);
  window.open = (url?: string | URL, target?: string, features?: string) => {
    const at = new URL(String(url ?? ''), window.location.href);
    if (at.origin !== window.location.origin) return open(url, target, features);
    if (at.pathname.startsWith('/window/')) {
      open(at.href, '_blank', `${features ? `${features},` : ''}noopener`);
    } else {
      opener?.postMessage({ path: `${at.pathname}${at.search}` });
    }
    return null;
  };
  const bridge: Omit<PenmossDesktop, 'session' | 'openInBrowser' | 'admin'> = {
    platform: config.platform,
    version: '0.0.0-e2e',
    window: kind,
    menu: {
      set: (menus) => void (state.menus = menus),
      onCommand: (listener) => listen(menuListeners, listener),
      takePending: () => Promise.resolve(null),
    },
    theme: { set: (theme) => void (state.theme = theme) },
    git: {
      list: () => host('list'),
      add: (input) => host('add', input),
      remove: (localId, unpushed) => host('remove', localId, unpushed),
      update: (localId, patch) => host('update', localId, patch),
      setToken: (localId, token) => host('setToken', localId, token),
      purgeCheck: (localId, noteId) => host('purgeCheck', localId, noteId),
      restoreCheck: (localId, noteId, revert) => host('restoreCheck', localId, noteId, revert),
      purgesToConfirm: (localId, also) => host('purgesToConfirm', localId, also ?? []),
      writerSecret: (localId, value) =>
        value === undefined ? host('writerSecret', localId) : host('writerSecret', localId, value),
      op: (localId, op, args) => host('op', localId, op, args),
      cancel: (localId) => host('cancel', localId),
      identity: () => host('identity'),
      onChange: (listener) => listen(gitListeners, listener),
      agents: () => Promise.resolve({ ok: true, value: [] }),
      connectAgent: () => Promise.resolve(none),
      disconnectAgent: () => Promise.resolve(none),
      cli: () => host('cliStatus'),
      // Browsing GitHub in Add a Git Notebook (T81): main's GitHubBrowseHost on the stand-in Mac.
      github: {
        repos: () => host('githubRepos'),
        folders: (fullName, branch) => host('githubFolders', fullName, branch),
        owners: () => host('githubOwners'),
        create: (owner, name) => host('githubCreate', owner, name),
        // Sign in with GitHub (T82): main's DeviceSignIn on the stand-in Mac.
        signIn: {
          status: () => host('githubSignInStatus'),
          start: () => host('githubSignInStart'),
          cancel: () => host('githubSignInCancel'),
          onChange: (listener) => listen(signInListeners, listener as (state: unknown) => void),
        },
      },
      installCli: () => Promise.resolve(none),
      removeCli: () => Promise.resolve(none),
    },
    feedback: {
      capture: () => Promise.resolve(null),
      file: (payload, screenshots) =>
        host(
          'feedbackFile',
          payload,
          screenshots.map(({ type, bytes }) => ({ type, bytes })),
        ),
    },
    githubToken: {
      status: () => host('tokenStatus'),
      save: (token) => host('tokenSave', token),
      remove: () => host('tokenRemove'),
      onChange: (listener) => listen(tokenListeners, listener),
    },
    updates: {
      state: () => host('updatesState'),
      check: () => host('updatesCheck'),
      setAuto: (on) => host('updatesSetAuto', on),
      setChannel: (channel) => host('updatesSetChannel', channel),
      install: () => host('updatesInstall'),
      // The notice after an update (PEN-110) and its release notes (PEN-108).
      acknowledge: () => host('updatesAcknowledge'),
      notes: () => host('updatesNotes'),
      onChange: (listener) => listen(updateListeners, listener as (state: unknown) => void),
    },
    // Search by meaning (T77): main's relay to the stand-in Mac's service, when it has one.
    ...(config.meaning
      ? {
          meaning: {
            status: () => host('meaningStatus'),
            update: (notebookId, notes) => host('meaningUpdate', notebookId, notes),
            close: (notebookId) => host('meaningClose', notebookId),
            search: (notebookId, query, options) =>
              host('meaningSearch', notebookId, query, options ?? {}),
            setEnabled: (on) => host('meaningSetEnabled', on),
            onChange: (listener) => listen(meaningListeners, listener as (status: unknown) => void),
          },
        }
      : {}),
    clipboard: {
      write: async (data) => {
        try {
          if (data.html) {
            await navigator.clipboard.write([
              new ClipboardItem({
                'text/plain': new Blob([data.text], { type: 'text/plain' }),
                'text/html': new Blob([data.html], { type: 'text/html' }),
              }),
            ]);
          } else {
            await navigator.clipboard.writeText(data.text);
          }
          return true;
        } catch {
          return false;
        }
      },
    },
    ...(config.macWindow && kind !== 'capture'
      ? {
          macWindow: {
            titleBar: 'compact' as const,
            state: () => Promise.resolve(macState),
            onState: (listener: (state: typeof macState) => void) => listen(macListeners, listener),
            setKeepOnTop: (keepOnTop: boolean) => {
              macState = { ...macState, keepOnTop };
              for (const listener of macListeners) listener(macState);
              return Promise.resolve(macState);
            },
            setCompactTitleBar: (compact: boolean) => Promise.resolve({ compact, reopened: false }),
          },
        }
      : {}),
    onBeforeClose: () => () => undefined,
    onStoreChanged: (listener) => listen(storeListeners, listener),
    stored: (ids) => store?.postMessage({ ids }),
    onOpenPath: (listener) => listen(openPaths, listener),
    capture: {
      done: () => undefined,
      onShow: () => () => undefined,
      hotkey: () => Promise.resolve({ accelerator: '', registered: false, certain: false }),
      setHotkey: (accelerator) =>
        Promise.resolve({ accelerator, registered: false, certain: false }),
    },
  };
  // Signed out, and no account to sign in to (D48, D49). Kept untyped: the bridge is losing
  // these members, and the page reads them only while it still has them.
  const signedOut = {
    session: {
      get: () => Promise.resolve(null),
      signIn: () => Promise.resolve(false),
      signOut: () => Promise.resolve(null),
      forget: () => Promise.resolve(),
      onChange: () => () => undefined,
    },
    openInBrowser: () => Promise.resolve(false),
  };
  Object.defineProperty(window, 'penmossDesktop', {
    value: Object.freeze({ ...signedOut, ...bridge }),
    configurable: false,
    writable: false,
  });
}
