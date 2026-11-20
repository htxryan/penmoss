/**
 * The page's only door to the Mac app (T29): a few named calls over IPC,
 * exposed as `window.penmossDesktop` through the context bridge. No Node,
 * no Electron objects, no raw ipcRenderer reach the page; listeners receive
 * plain data. Its shape is the page's `PenmossDesktop`
 * (apps/web/src/desktop/bridge.ts), checked below; the channels and who may
 * use them are ipc-contract.ts.
 *
 * Calls that need a person behind them (the clipboard, the capture hotkey)
 * carry `navigator.userActivation.isActive`, read here in the isolated world
 * where a page script cannot change it; the main process decides with it.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopGit, MenuBarPin, PenmossDesktop } from '../../web/src/desktop/bridge';
import {
  EVENT,
  INVOKE,
  SEND,
  TITLE_BAR_ARG,
  VERSION_ARG,
  WINDOW_ARG,
  type EventName,
  type Events,
  type InvokeArgs,
  type InvokeName,
  type InvokeResult,
  type InvokeRule,
  type SendName,
  type Sends,
} from './ipc-contract';
import { StoreAnswers } from './store-requests';

const arg = (prefix: string) =>
  process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? '';

/** Whether the page has just had a key press or click (transient user activation). */
const gesture = () => navigator.userActivation?.isActive === true;

const INVOKE_RULES: { readonly [K in InvokeName]: InvokeRule<InvokeResult<K>> } = INVOKE;

/** Calls main; a call whose rule asks for a gesture sends it first. */
function invoke<K extends InvokeName>(name: K, ...args: InvokeArgs<K>): Promise<InvokeResult<K>> {
  const rule = INVOKE_RULES[name];
  return rule.gesture === undefined
    ? ipcRenderer.invoke(rule.channel, ...args)
    : ipcRenderer.invoke(rule.channel, gesture(), ...args);
}

function send<K extends SendName>(name: K, ...args: Sends[K]): void {
  ipcRenderer.send(SEND[name].channel, ...args);
}

/** Subscribes to a main-process event; returns the unsubscribe. */
function on<K extends EventName>(name: K, listener: (value: Events[K]) => void): () => void {
  const handler = (_event: unknown, value: Events[K]) => listener(value);
  ipcRenderer.on(EVENT[name], handler);
  return () => {
    ipcRenderer.removeListener(EVENT[name], handler);
  };
}

/** Which window this is: the main window, a note window (T45, A712) or the capture window. */
const windowKind = ((kind) => (kind === 'capture' || kind === 'note' ? kind : 'main'))(
  arg(WINDOW_ARG),
);

/**
 * The Mac's window behaviours (T46, T47; A720–A725): main and note windows only, and only where
 * the main process passed a title-bar style (on a Mac, or the suite standing in for one).
 */
const titleBar = ((style) => (style === 'compact' || style === 'native' ? style : null))(
  arg(TITLE_BAR_ARG),
);

type CaptureGit = Pick<DesktopGit, 'list' | 'onChange'>;

/**
 * Git notebooks (T50 G3, G5; A853–A857): main runs git and keeps each notebook's token; the
 * page's engine calls git through `op`. The owner checks (Remove, Delete for good) carry the
 * gesture: main refuses without one, then asks Touch ID. Main and note windows only.
 */
/** An account named by the page (A1617): a login, null for one GitHub never named, else none. */
const accountArg = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' ? value : undefined;

const git = {
  list: () => invoke('gitList'),
  add: (input) => invoke('gitAdd', input),
  remove: (localId, unpushed) =>
    invoke('gitRemove', String(localId), typeof unpushed === 'number' ? unpushed : null),
  update: (localId, patch) => invoke('gitUpdate', String(localId), patch),
  setToken: (localId, token) =>
    invoke('gitToken', String(localId), token === null ? null : String(token)),
  restoreCheck: (localId, noteId, revert) =>
    invoke('gitRestoreCheck', String(localId), String(noteId), revert === true),
  purgeCheck: (localId, noteId) =>
    invoke(
      'gitPurgeCheck',
      String(localId),
      Array.isArray(noteId) ? noteId.map(String) : String(noteId),
    ),
  purgesToConfirm: (localId, also) =>
    invoke('gitPurgesToConfirm', String(localId), Array.isArray(also) ? also.map(String) : []),
  writerSecret: (localId, value) => invoke('gitSecret', String(localId), value),
  op: (localId, op, args) => invoke('gitOp', String(localId), String(op), args),
  cancel: (localId) => invoke('gitCancel', String(localId)),
  identity: () => invoke('gitIdentity'),
  onChange: (listener) => on('gitChanged', () => listener()),
  // Browsing GitHub in Add a Git Notebook (T81, A1165): main answers the main window only.
  github: {
    // `account`: one of Penmoss's accounts (A1617); left out, git's sign-in, else the first.
    repos: (account) => invoke('gitGithubRepos', accountArg(account)),
    folders: (fullName, branch, account) =>
      invoke('gitGithubFolders', String(fullName), String(branch), accountArg(account)),
    owners: (account) => invoke('gitGithubOwners', accountArg(account)),
    create: (owner, name, account) =>
      invoke(
        'gitGithubCreate',
        { login: String(owner?.login), kind: String(owner?.kind) },
        String(name),
        accountArg(account),
      ),
    gitLogin: () => invoke('gitGithubGitLogin'),
    // Sign in with GitHub (T82, A1170): the code to enter and the outcome, never the token.
    signIn: {
      status: () => invoke('githubSignInStatus'),
      start: () => invoke('githubSignInStart'),
      cancel: () => invoke('githubSignInCancel'),
      onChange: (listener) => on('githubSignInChanged', (state) => listener(state)),
    },
  },
  // Agents on this Mac (T54, A992, A993): main refuses them outside the main window.
  agents: (localId) => invoke('agentsList', String(localId)),
  connectAgent: (localId, label) => invoke('agentsConnect', String(localId), String(label)),
  disconnectAgent: (name, force) => invoke('agentsDisconnect', String(name), force === true),
  cli: () => invoke('cliStatus'),
  installCli: () => invoke('cliInstall'),
  removeCli: () => invoke('cliRemove'),
} satisfies DesktopGit;

/** The capture window lists git notebooks only, to file captures in the Journal notebook (A827). */
const captureGit = {
  list: git.list,
  onChange: git.onChange,
} satisfies CaptureGit;

/** A call main refuses this window (it answers null): the page's promise rejects. */
const required = <T>(value: T | null): T | Promise<never> =>
  value ?? Promise.reject(new Error('Not available in this window'));

/**
 * Usage analytics and the log file (PEN-137): events and log lines go to main as messages, never
 * waited for; the answer, the switch, the ID and the limits are the main window's (Settings →
 * Privacy, the consent question), and turning sharing on carries the gesture.
 */
const analytics = {
  record: (events) => send('analyticsRecord', Array.isArray(events) ? events : []),
  log: (level, message) =>
    send('analyticsLog', level === 'error' ? 'error' : 'warn', String(message)),
  status: () => invoke('analyticsStatus').then(required),
  onChange: (listener) => on('analyticsChanged', (status) => listener(status)),
  answer: (consent) => invoke('analyticsAnswer', consent === 'yes' ? 'yes' : 'no').then(required),
  setSharing: (on) => invoke('analyticsSetSharing', on === true).then(required),
  resetId: () => invoke('analyticsResetId').then(required),
  forget: () => invoke('analyticsForget').then(required),
  page: (query) => invoke('analyticsPage', query ?? {}).then(required),
  preview: (changes) => invoke('analyticsPreview', changes ?? {}).then(required),
  setLimits: (changes) => invoke('analyticsSetLimits', changes ?? null).then(required),
  showLogFile: () => invoke('analyticsShowLogFile').then((shown) => shown === true),
  reportLogs: (names) =>
    invoke('analyticsReportLogs', Array.isArray(names) ? names.map(String) : []).then(required),
} satisfies NonNullable<PenmossDesktop['analytics']>;

/** Main and note windows' own members: the capture window has none of them. */
const appWindow = {
  analytics,
  // Send feedback (T49, A798): the window as it is now, as PNG bytes (or null), taken by the main
  // process with capturePage before the form is drawn.
  feedback: {
    capture: () => invoke('feedbackCapture'),
    // Filed by main with the person's GitHub token (T57, A1010): the payload part and the
    // screenshots' bytes, as the outbox keeps them.
    file: (payload, screenshots) => invoke('feedbackFile', String(payload), screenshots),
  },
  // The person's GitHub token (A1012): saved and removed after a gesture; never read back.
  githubToken: {
    status: () => invoke('githubTokenStatus'),
    save: (token) => invoke('githubTokenSave', String(token)),
    remove: (login) => invoke('githubTokenRemove', accountArg(login)),
    makePrimary: (login) => invoke('githubTokenMakePrimary', String(login)),
    onChange: (listener) => on('githubTokenChanged', () => listener()),
  },
  // Search by meaning (T76, A1152): main relays each call to the embedding service. The switch
  // (A1158) carries the gesture; main takes it from the main window only.
  meaning: {
    status: () => invoke('meaningStatus'),
    update: (notebookId, notes) => invoke('meaningUpdate', String(notebookId), notes),
    close: (notebookId) => invoke('meaningClose', String(notebookId)),
    search: (notebookId, query, options) =>
      invoke('meaningSearch', String(notebookId), String(query), options),
    setEnabled: (value) => invoke('meaningSetEnabled', value === true),
    removeModel: () => invoke('meaningRemoveModel'),
    removeIndex: () => invoke('meaningRemoveIndex'),
    onChange: (listener) => on('meaningChanged', (status) => listener(status)),
  },
  // Auto-Update (T64 item 2, A1112, A1196): the switch, the channel and Install and Restart
  // carry the gesture.
  updates: {
    state: () => invoke('updatesState'),
    check: () => invoke('updatesCheck'),
    setAuto: (value) => invoke('updatesSetAuto', value === true),
    setChannel: (value) => invoke('updatesSetChannel', value === 'alpha' ? 'alpha' : 'stable'),
    install: () => invoke('updatesInstall'),
    // The notice after an update was answered (PEN-110): after a click only.
    acknowledge: () => invoke('updatesAcknowledge'),
    onChange: (listener) => on('updatesChanged', (state) => listener(state)),
    // Release notes (PEN-108): main's cached file; asking fetches a newer one.
    notes: () => invoke('updatesNotes'),
    onNotes: (listener) => on('updatesNotesChanged', (file) => listener(file)),
  },
} satisfies Pick<PenmossDesktop, 'analytics' | 'feedback' | 'githubToken' | 'meaning' | 'updates'>;

/** Keep on top and the compact title bar (T46, T47; A720–A725), for `titleBar`'s windows. */
const macWindow = (style: 'compact' | 'native') =>
  ({
    titleBar: style,
    // This window's keep-on-top and full-screen state, and its changes.
    state: () => invoke('windowState'),
    onState: (listener) => on('windowStateChanged', listener),
    setKeepOnTop: (keepOnTop) => invoke('keepOnTop', keepOnTop === true),
    // Settings → Appearance, after a key press or click: main asks first, stores every
    // window's notes, then reopens the windows (A724).
    setCompactTitleBar: (compact) => invoke('compactTitleBar', compact === true),
  }) satisfies NonNullable<PenmossDesktop['macWindow']>;

/**
 * The menu bar icon (T51 item 17, A945): on a Mac (or the suite standing in for one), in main
 * and note windows. Settings → Quick Capture turns it on or off, after a key press or click; the
 * main window's page sends the Quick Access notes its menu lists (A946), ids and titles only.
 */
const menuBar = {
  shown: () => invoke('menuBarIconGet'),
  setShown: (shown) => invoke('menuBarIconSet', shown === true),
  ...(windowKind === 'main'
    ? {
        setQuickAccess: (pins: readonly MenuBarPin[]) =>
          send('quickAccessSet', Array.isArray(pins) ? pins : []),
      }
    : {}),
} satisfies NonNullable<PenmossDesktop['menuBar']>;

const api = {
  platform: process.platform,
  version: arg(VERSION_ARG),
  window: windowKind,
  menu: {
    set: (menus) => send('menuSet', menus),
    onCommand: (listener) => on('menuCommand', listener),
    takePending: () => invoke('menuCommandPending'),
  },
  theme: {
    set: (theme) => send('themeSet', theme),
  },
  clipboard: {
    write: (data) => invoke('clipboardWrite', data),
  },
  ...(windowKind !== 'capture' ? appWindow : {}),
  git: windowKind === 'capture' ? captureGit : git,
  ...(windowKind !== 'capture' && titleBar ? { macWindow: macWindow(titleBar), menuBar } : {}),
  // `saved` says whether the page stored everything (A724: a window reopens only then).
  // `close` as a window closes or the app quits, else `flush`: store only (#174 review).
  // Each ask has an id, and the reply carries it; a flush waits for a close already running
  // (#174 delta review).
  onBeforeClose: (save) => {
    const answers = new StoreAnswers(save);
    return on('save', (request) => {
      void answers.answer(request).then((reply) => {
        if (reply) send('saved', reply);
      });
    });
  },
  // Another window stored records (their ids, T45, A711; none: read everything).
  onStoreChanged: (listener) =>
    on('storeChanged', (ids) => listener(Array.isArray(ids) ? ids : undefined)),
  stored: (ids) => send('stored', Array.isArray(ids) ? ids : null),
  onOpenPath: (listener) => on('openPath', listener),
  capture: {
    done: (saved) => send('captureDone', saved === true),
    onShow: (listener) => on('captureShow', () => listener()),
    hotkey: () => invoke('captureHotkey'),
    setHotkey: (accelerator) => invoke('captureSetHotkey', String(accelerator)),
  },
} satisfies Omit<PenmossDesktop, 'git'> & { readonly git: DesktopGit | CaptureGit };

contextBridge.exposeInMainWorld('penmossDesktop', api);
