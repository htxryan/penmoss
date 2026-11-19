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
 * - `analytics` (PEN-137), only when a spec asks for it (`test.use({ analytics: … })`): main's
 *   usage analytics with a memory store, the answer, the limits and the log, kept in
 *   localStorage so a reload keeps them (`window.__penmossFakeAnalytics` shows them to specs).
 *
 * This function is serialized into each page (`addInitScript`): it must not close over anything.
 * Bytes cross the binding as base64 (`{ __bytes }`), both ways.
 */
import type {
  DesktopAnalytics,
  DesktopAnalyticsStatus,
  MenuCommandEvent,
  PenmossDesktop,
} from '../../../src/desktop/bridge';
import type { Page, PageQuery, StateName, StoredEvent } from '@penmoss/core/analytics';

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

/**
 * The stand-in Mac's usage analytics (PEN-137), as a spec starts it: the answer so far, how many
 * events the record holds (spread over the last six days, newest first: mac, cli and mcp in turn),
 * the logs' size, and whether Penmoss's server can be reached for Delete My Shared Data.
 */
export interface FakeAnalyticsConfig {
  readonly consent?: 'yes' | 'no' | null;
  /** Whether main asks (an install with a notebook and no answer); default: no answer yet. */
  readonly ask?: boolean;
  readonly events?: number;
  /** The logs' size on disk, in bytes (default 6 MB). */
  readonly logBytes?: number;
  readonly limits?: Readonly<Record<string, number>>;
  /** Delete My Shared Data finds the server unreachable. */
  readonly offline?: boolean;
  /** The lines a bug report attaches (`reportLogs`). */
  readonly reportLines?: readonly string[];
}

/** The fake's state, as `window.__penmossFakeAnalytics` shows it (and localStorage keeps it). */
export interface FakeAnalyticsState {
  consent: 'yes' | 'no' | null;
  ask: boolean;
  install: string;
  sharingSince: number | null;
  limits: Record<string, number>;
  logBytes: number;
  lastBatch: string | null;
  events: StoredEvent[];
  nextId: number;
  /** Each call that changed something, by name: `answer:yes`, `forget`, `setLimits`… */
  calls: string[];
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
    __penmossFakeAnalytics?: FakeAnalyticsState;
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
  /** Usage analytics (PEN-137); none unless a spec asks. */
  readonly analytics?: FakeAnalyticsConfig | null;
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
      // Sized as main makes it (720×800, `createNoteWindow`).
      open(at.href, '_blank', 'popup,width=720,height=800,noopener');
    } else {
      opener?.postMessage({ path: `${at.pathname}${at.search}` });
    }
    return null;
  };
  /**
   * Usage analytics (PEN-137): main's store, answer and limits in the page, as small as the specs
   * need. Events are kept newest first by (at, id), as the store's keyset pages them.
   */
  const fakeAnalytics = (config: FakeAnalyticsConfig): DesktopAnalytics => {
    const KEY = 'penmoss:fake-analytics';
    const DAY = 86_400_000;
    const DEFAULTS: Record<string, number> = {
      'events.days': 7,
      'events.max': 5000,
      'logs.fileKb': 1024,
      'logs.files': 2,
      'logs.days': 7,
      'report.hours': 24,
      'report.lines': 300,
      'report.kb': 16,
    };
    const hex = (bytes: number) =>
      Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
    const seed = (): FakeAnalyticsState => {
      const now = Date.now();
      const count = config.events ?? 0;
      const consent = config.consent ?? null;
      const clients = ['mac', 'cli', 'mcp'] as const;
      const names = {
        mac: ['command', 'app.search'],
        cli: ['cli', 'search'],
        mcp: ['tool', 'read_note'],
      };
      const states: StateName[] =
        consent === 'yes'
          ? ['sent', 'sent', 'waiting']
          : consent === 'no'
            ? ['local']
            : ['pending'];
      const events: StoredEvent[] = [];
      for (let index = 0; index < count; index++) {
        const client = clients[index % 3]!;
        const [kind, name] = names[client];
        events.push({
          id: count - index,
          // Newest first, over six days.
          at: now - 60_000 - Math.floor((index * 6 * DAY) / Math.max(count, 1)),
          session: '0123456789abcdef',
          seq: count - index,
          client,
          actor: client === 'mcp' ? 'agent' : 'person',
          version: '0.0.0',
          channel: 'dev',
          os: 'macos',
          osVersion: '15.1',
          kind: kind as StoredEvent['kind'],
          name: name!,
          props: client === 'mac' ? { source: 'key', keys: 'Mod+K' } : {},
          state: states[Math.floor(index / 3) % states.length]!,
          sentAt: null,
        });
      }
      return {
        consent,
        ask: config.ask ?? consent === null,
        install: hex(16),
        sharingSince: consent === 'yes' ? now - 30 * DAY : null,
        limits: { ...DEFAULTS, ...config.limits },
        logBytes: config.logBytes ?? 6 * 1024 * 1024,
        lastBatch: null,
        events,
        nextId: count + 1,
        calls: [],
      };
    };
    const read = (): FakeAnalyticsState | null => {
      try {
        const raw = localStorage.getItem(KEY);
        return raw ? (JSON.parse(raw) as FakeAnalyticsState) : null;
      } catch {
        return null;
      }
    };
    const fake: FakeAnalyticsState = read() ?? seed();
    window.__penmossFakeAnalytics = fake;
    const listeners = new Set<(status: DesktopAnalyticsStatus) => void>();
    const status = (): DesktopAnalyticsStatus => {
      const counts = { pending: 0, local: 0, waiting: 0, sent: 0, refused: 0 };
      for (const event of fake.events) counts[event.state] += 1;
      return {
        consent: fake.consent,
        ask: fake.ask && fake.consent === null,
        install: fake.install,
        sharingSince: fake.sharingSince,
        counts,
        limits: { ...fake.limits } as DesktopAnalyticsStatus['limits'],
        logBytes: fake.logBytes,
        lastBatch: fake.lastBatch,
        optedOut: false,
      };
    };
    const changed = (call?: string) => {
      if (call) fake.calls.push(call);
      try {
        localStorage.setItem(KEY, JSON.stringify(fake));
      } catch {
        // A full or blocked store: the page's copy still holds.
      }
      const now = status();
      for (const listener of listeners) listener(now);
      return now;
    };
    const newestFirst = (a: StoredEvent, b: StoredEvent) => b.at - a.at || b.id - a.id;
    /** What `limits` would delete: events past their age or cap, logs past their size or age. */
    const outside = (limits: Record<string, number>) => {
      const now = Date.now();
      const sorted = [...fake.events].sort(newestFirst);
      const gone = sorted.filter(
        (event, index) =>
          event.at < now - limits['events.days']! * DAY || index >= limits['events.max']!,
      );
      const room = limits['logs.fileKb']! * 1024 * limits['logs.files']!;
      const aged = limits['logs.days']! < fake.limits['logs.days']! ? fake.logBytes / 2 : 0;
      const logBytes = Math.max(fake.logBytes - room, Math.round(aged), 0);
      return { gone: new Set(gone.map((event) => event.id)), logBytes };
    };
    const unsent = (to: StateName) => {
      fake.events = fake.events.map((event) =>
        event.state === 'pending' || event.state === 'waiting' ? { ...event, state: to } : event,
      );
    };
    return {
      record: (events) => {
        const state: StateName =
          fake.consent === null ? 'pending' : fake.consent === 'yes' ? 'waiting' : 'local';
        for (const event of events) {
          const id = fake.nextId++;
          fake.events.push({
            id,
            at: event.at,
            session: 'fedcba9876543210',
            seq: id,
            client: 'mac',
            actor: 'person',
            version: '0.0.0',
            channel: 'dev',
            os: 'macos',
            osVersion: '15.1',
            ...(event.sizeClass ? { sizeClass: event.sizeClass } : {}),
            kind: event.kind,
            name: event.name,
            props: event.props ?? {},
            state,
            sentAt: null,
          });
        }
        // The page's memory sink too, which the instrumentation specs read.
        (window.__penmossAnalytics ??= []).push(...events);
        changed();
      },
      log: () => undefined,
      status: () => Promise.resolve(status()),
      onChange: (listener) => listen(listeners, listener),
      answer: (consent) => {
        fake.consent = consent;
        fake.ask = false;
        if (consent === 'yes') fake.sharingSince = Date.now();
        unsent(consent === 'yes' ? 'waiting' : 'local');
        return Promise.resolve(changed(`answer:${consent}`));
      },
      setSharing: (on) => {
        fake.consent = on ? 'yes' : 'no';
        fake.sharingSince = on ? Date.now() : null;
        if (!on) unsent('local');
        return Promise.resolve(changed(`sharing:${on ? 'on' : 'off'}`));
      },
      resetId: () => {
        fake.install = hex(16);
        unsent('local');
        return Promise.resolve(changed('resetId'));
      },
      forget: () => {
        if (config.offline) return Promise.resolve({ outcome: 'offline' as const });
        fake.install = hex(16);
        unsent('local');
        changed('forget');
        return Promise.resolve({ outcome: 'ok' as const });
      },
      page: (query: PageQuery): Promise<Page> => {
        const state = query.state ?? 'all';
        const client = query.client ?? 'all';
        const matching = fake.events
          .filter((event) => state === 'all' || event.state === state)
          .filter(
            (event) =>
              client === 'all' ||
              (client === 'app'
                ? event.client === 'mac' || event.client === 'android'
                : event.client === client),
          )
          .sort(newestFirst);
        const limit = query.limit ?? 100;
        const older = (event: StoredEvent, at: { at: number; id: number }) =>
          event.at < at.at || (event.at === at.at && event.id < at.id);
        let events: StoredEvent[];
        if (query.before) {
          const cursor = query.before;
          events = matching.filter((event) => older(event, cursor)).slice(0, limit);
        } else if (query.after) {
          const cursor = query.after;
          const newer = matching.filter((event) => event.id !== cursor.id && !older(event, cursor));
          events = newer.slice(Math.max(0, newer.length - limit));
        } else {
          events = matching.slice(0, limit);
        }
        const first = events[0];
        const newer = first ? matching.indexOf(first) : 0;
        return Promise.resolve({ events, total: matching.length, newer });
      },
      preview: (changes) => {
        const { gone, logBytes } = outside({ ...fake.limits, ...changes });
        return Promise.resolve({ events: gone.size, logBytes });
      },
      setLimits: (changes) => {
        const next = changes === null ? { ...DEFAULTS } : { ...fake.limits, ...changes };
        const { gone, logBytes } = outside(next);
        fake.events = fake.events.filter((event) => !gone.has(event.id));
        fake.logBytes -= logBytes;
        fake.limits = next;
        return Promise.resolve(changed(changes === null ? 'setLimits:reset' : 'setLimits'));
      },
      showLogFile: () => {
        changed('showLogFile');
        return Promise.resolve(true);
      },
      reportLogs: () => {
        const lines = [...(config.reportLines ?? [])];
        const bytes = lines.reduce(
          (sum, line) => sum + new TextEncoder().encode(line).length + 1,
          0,
        );
        return Promise.resolve({ lines, bytes });
      },
    };
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
        repos: (account) => host('githubRepos', account),
        folders: (fullName, branch, account) => host('githubFolders', fullName, branch, account),
        owners: (account) => host('githubOwners', account),
        create: (owner, name, account) => host('githubCreate', owner, name, account),
        gitLogin: () => host('githubGitLogin'),
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
      remove: (login) => host('tokenRemove', login),
      makePrimary: (login) => host('tokenMakePrimary', login),
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
      onNotes: () => () => undefined,
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
            removeModel: () => host('meaningRemoveModel'),
            removeIndex: () => host('meaningRemoveIndex'),
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
    ...(config.analytics ? { analytics: fakeAnalytics(config.analytics) } : {}),
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
