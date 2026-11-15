/**
 * The IPC contract between the main process and the preload (T29, A224, A503, A712): every
 * channel, who may use it, whether it needs a person behind it, and what it carries. Main
 * registers its handlers through `ipc.ts`, which applies the policy written here; the preload
 * calls through the typed helpers below, and its `window.penmossDesktop` is checked against the
 * page's own description of it (`apps/web/src/desktop/bridge.ts`, `PenmossDesktop`). So a
 * channel's types and its guard are stated once, and `test/unit/ipc-contract.test.ts` lists the
 * policy, so a change to it shows in the diff.
 *
 * Plain data only: the preload bundles this file, and no Electron is imported here.
 */
import type {
  CaptureHotkey,
  CliInfo,
  ClipboardWrite,
  DesktopFeedbackAnswer,
  DesktopGitHubTokenStatus,
  DesktopMenu,
  DesktopMeaningHit,
  DesktopMeaningNote,
  DesktopMeaningStatus,
  DesktopReleaseNotes,
  DesktopTheme,
  DesktopUpdateChannel,
  DesktopUpdateState,
  GitAddResult,
  GitAnswer,
  GitHubAnswer,
  GitHubOwner,
  GitHubRepo,
  GitHubSignInState,
  GitNotebookInfo,
  GitPendingPurge,
  LocalAgentInfo,
  MacWindowState,
  MenuBarPin,
  MenuCommandEvent,
  RepoFolders,
  RepoList,
} from '../../web/src/desktop/bridge';
import type { StoreReply, StoreRequest } from './store-requests';

/**
 * Who may use a channel, checked by main on every message (`ipc.ts`):
 * - `app`: any of the app's own pages, the capture window's too (A224);
 * - `window`: a main or note window's page, never the capture window's (A503, A712);
 * - `main`: the main window's page alone (Settings, T54);
 * - `mac`: a main or note window with the Mac's window behaviours (T46, T47; A725).
 */
export type Caller = 'app' | 'window' | 'main' | 'mac';

/** The owner checks need a person behind them: refused without a key press or click (A855). */
export const NEEDS_A_PERSON = {
  ok: false,
  error: { code: 'not_confirmed', message: 'Not done: confirm with a click or a key press.' },
} as const;

/** The same refusal in the GitHub token's own shape (A1012). */
const TOKEN_NEEDS_A_PERSON = { ok: false, message: NEEDS_A_PERSON.error.message } as const;

/** And in GitHub browsing's (T81): its errors have a reason, not a code. */
const BROWSE_NEEDS_A_PERSON = {
  ok: false,
  error: { reason: 'github', message: NEEDS_A_PERSON.error.message },
} as const;

/**
 * Whether a call carries the preload's `navigator.userActivation.isActive` (read in the isolated
 * world, where a page script cannot set it), sent as the first argument after the channel:
 * - `{ refused }`: main answers `refused` without a key press or click, before the handler runs;
 * - `'handler'`: the handler decides with it (a gate, or only some changes need a person).
 */
export type GestureRule<R> = { readonly refused: R } | 'handler';

export interface InvokeRule<R> {
  readonly channel: string;
  readonly from: Caller;
  readonly gesture?: GestureRule<R>;
  /** What main answers a caller `from` does not allow; null when absent. */
  readonly refused?: R;
}

export interface SendRule {
  readonly channel: string;
  /** Null: main checks the sender itself (a store reply goes only to the ask that waits for it). */
  readonly from: Caller | null;
}

/** A page's call that main answers (`ipcRenderer.invoke`, `ipcMain.handle`): its args and answer. */
interface Call<A extends readonly unknown[], R> {
  readonly args: A;
  readonly result: R;
}

type Updated = DesktopUpdateState | null;
type TokenAnswer<T> = { readonly ok: true } & T;
type TokenRefusal = { readonly ok: false; readonly message: string };

/** Every call a page makes, as the page sends it and as main answers. */
export interface Invokes {
  menuCommandPending: Call<[], string | { readonly path: string } | null>;
  clipboardWrite: Call<[data: ClipboardWrite], boolean>;
  windowState: Call<[], MacWindowState | null>;
  keepOnTop: Call<[on: boolean], MacWindowState | null>;
  compactTitleBar: Call<
    [compact: boolean],
    { readonly compact: boolean; readonly reopened: boolean } | null
  >;
  menuBarIconGet: Call<[], boolean | null>;
  menuBarIconSet: Call<[shown: boolean], boolean | null>;
  feedbackCapture: Call<[], Uint8Array | null>;
  feedbackFile: Call<
    [
      payload: string,
      screenshots: ReadonlyArray<{ readonly type: string; readonly bytes: Uint8Array }>,
    ],
    DesktopFeedbackAnswer | null
  >;
  githubTokenStatus: Call<[], DesktopGitHubTokenStatus | null>;
  githubTokenSave: Call<
    [token: string],
    | TokenAnswer<{ readonly status: DesktopGitHubTokenStatus; readonly note: string | null }>
    | TokenRefusal
    | null
  >;
  githubTokenRemove: Call<
    [],
    TokenAnswer<{ readonly status: DesktopGitHubTokenStatus }> | TokenRefusal | null
  >;
  githubSignInStatus: Call<
    [],
    {
      readonly available: boolean;
      readonly state: GitHubSignInState;
      readonly login: string | null;
    } | null
  >;
  githubSignInStart: Call<[], GitHubSignInState | GitAnswer<never> | null>;
  githubSignInCancel: Call<[], null>;
  updatesState: Call<[], Updated>;
  updatesCheck: Call<[], Updated>;
  updatesSetAuto: Call<[on: boolean], Updated>;
  updatesSetChannel: Call<[channel: DesktopUpdateChannel], Updated>;
  updatesInstall: Call<[], Updated>;
  updatesAcknowledge: Call<[], Updated>;
  updatesNotes: Call<[], DesktopReleaseNotes | null>;
  meaningStatus: Call<[], DesktopMeaningStatus | null>;
  meaningUpdate: Call<[notebookId: string, notes: readonly DesktopMeaningNote[]], string[]>;
  meaningClose: Call<[notebookId: string], void>;
  meaningSearch: Call<
    [
      notebookId: string,
      query: string,
      options?: { readonly limit?: number; readonly ids?: readonly string[] },
    ],
    { readonly floor: number; readonly hits: DesktopMeaningHit[] } | null
  >;
  meaningSetEnabled: Call<[on: boolean], DesktopMeaningStatus | null>;
  meaningRemoveModel: Call<[], DesktopMeaningStatus | null>;
  meaningRemoveIndex: Call<[], DesktopMeaningStatus | null>;
  gitList: Call<[], GitNotebookInfo[]>;
  gitAdd: Call<
    [
      input: {
        readonly remote: string;
        readonly branch: string;
        readonly dir: string;
        readonly name?: string;
        readonly githubSignIn?: boolean;
      },
    ],
    GitAnswer<GitAddResult> | null
  >;
  gitRemove: Call<
    [localId: string, unpushed: number | null],
    GitAnswer<{ readonly notebookId: string }> | null
  >;
  gitUpdate: Call<[localId: string, patch: object], GitAnswer<GitNotebookInfo> | null>;
  gitToken: Call<[localId: string, token: string | null], GitAnswer<null> | null>;
  gitPurgeCheck: Call<
    [localId: string, noteId: string | readonly string[]],
    GitAnswer<null> | null
  >;
  gitRestoreCheck: Call<[localId: string, noteId: string, revert: boolean], GitAnswer<null> | null>;
  gitPurgesToConfirm: Call<
    [localId: string, also: readonly string[]],
    GitAnswer<readonly GitPendingPurge[]> | null
  >;
  gitSecret: Call<[localId: string, value?: string], GitAnswer<string | null> | null>;
  gitOp: Call<[localId: string, op: string, args: readonly unknown[]], GitAnswer<unknown> | null>;
  gitCancel: Call<[localId: string], null>;
  gitIdentity: Call<[], { readonly name: string; readonly email: string } | null>;
  gitGithubRepos: Call<[], GitHubAnswer<RepoList> | null>;
  gitGithubFolders: Call<[fullName: string, branch: string], GitHubAnswer<RepoFolders> | null>;
  gitGithubOwners: Call<[], GitHubAnswer<readonly GitHubOwner[]> | null>;
  gitGithubCreate: Call<
    // Main checks the owner's kind (`user` or `org`) itself.
    [owner: { readonly login: string; readonly kind: string }, name: string],
    GitHubAnswer<GitHubRepo> | null
  >;
  agentsList: Call<[localId: string], GitAnswer<readonly LocalAgentInfo[]> | null>;
  agentsConnect: Call<[localId: string, label: string], GitAnswer<LocalAgentInfo> | null>;
  agentsDisconnect: Call<[name: string, force: boolean], GitAnswer<null> | null>;
  cliStatus: Call<[], CliInfo | null>;
  cliInstall: Call<[], GitAnswer<CliInfo> | null>;
  cliRemove: Call<[], GitAnswer<CliInfo> | null>;
  captureHotkey: Call<[], CaptureHotkey | null>;
  captureSetHotkey: Call<
    [accelerator: string],
    (CaptureHotkey & { readonly error?: string }) | null
  >;
}

export type InvokeName = keyof Invokes;
export type InvokeArgs<K extends InvokeName> = Invokes[K]['args'];
export type InvokeResult<K extends InvokeName> = Invokes[K]['result'];

/** Every call's channel and policy. */
export const INVOKE = {
  // A command held for the main window while it loaded (A945); main also checks it is that page.
  menuCommandPending: { channel: 'penmoss:menu:command-pending', from: 'app' },
  // Only just after a key press or click, or a menu command: ClipboardGate decides.
  clipboardWrite: {
    channel: 'penmoss:clipboard:write',
    from: 'app',
    gesture: 'handler',
    refused: false,
  },
  // Keep on top and the compact title bar (T46, T47; A720–A724).
  windowState: { channel: 'penmoss:window:state', from: 'mac' },
  keepOnTop: { channel: 'penmoss:window:keep-on-top', from: 'mac' },
  compactTitleBar: {
    channel: 'penmoss:window:compact-title-bar',
    from: 'mac',
    gesture: { refused: null },
  },
  // The menu bar icon (T51 item 17, A945): this Mac's preference, set from Settings → Quick Capture.
  menuBarIconGet: { channel: 'penmoss:menu-bar-icon:get', from: 'mac' },
  menuBarIconSet: { channel: 'penmoss:menu-bar-icon:set', from: 'mac', gesture: { refused: null } },
  // Send feedback (T49, A798): a PNG of the asking window; filed with the person's GitHub token
  // (T57, A1010, A1012), which is never sent back to a page.
  feedbackCapture: { channel: 'penmoss:feedback:capture', from: 'window' },
  feedbackFile: { channel: 'penmoss:feedback:file', from: 'window' },
  githubTokenStatus: { channel: 'penmoss:github-token:status', from: 'window' },
  githubTokenSave: {
    channel: 'penmoss:github-token:save',
    from: 'main',
    gesture: { refused: TOKEN_NEEDS_A_PERSON },
  },
  githubTokenRemove: {
    channel: 'penmoss:github-token:remove',
    from: 'main',
    gesture: { refused: TOKEN_NEEDS_A_PERSON },
  },
  // Sign in with GitHub (T82, A1170): the device flow, from the main window.
  githubSignInStatus: { channel: 'penmoss:github:sign-in-status', from: 'main' },
  githubSignInStart: {
    channel: 'penmoss:github:sign-in-start',
    from: 'main',
    gesture: { refused: NEEDS_A_PERSON },
  },
  githubSignInCancel: { channel: 'penmoss:github:sign-in-cancel', from: 'main' },
  // Auto-Update (T64 item 2, A1112, A1196): anyone may read and check; the switch, the channel
  // and Install and Restart are the person's, in the main window.
  updatesState: { channel: 'penmoss:updates:state', from: 'window' },
  updatesCheck: { channel: 'penmoss:updates:check', from: 'window' },
  updatesSetAuto: { channel: 'penmoss:updates:set-auto', from: 'main', gesture: { refused: null } },
  updatesSetChannel: {
    channel: 'penmoss:updates:set-channel',
    from: 'main',
    gesture: { refused: null },
  },
  updatesInstall: { channel: 'penmoss:updates:install', from: 'main', gesture: { refused: null } },
  updatesAcknowledge: {
    channel: 'penmoss:updates:acknowledge',
    from: 'main',
    gesture: { refused: null },
  },
  updatesNotes: { channel: 'penmoss:updates:notes', from: 'window' },
  // Search by meaning (T76, A1152, A1158): main relays to the embedding service; the switch is
  // the main window's, after a gesture.
  meaningStatus: { channel: 'penmoss:meaning:status', from: 'window' },
  meaningUpdate: { channel: 'penmoss:meaning:update', from: 'window', refused: [] },
  meaningClose: { channel: 'penmoss:meaning:close', from: 'window' },
  meaningSearch: { channel: 'penmoss:meaning:search', from: 'window' },
  meaningSetEnabled: {
    channel: 'penmoss:meaning:set-enabled',
    from: 'main',
    gesture: { refused: null },
  },
  // Delete Model… (A1566): the main window's too, after the click that confirms it.
  meaningRemoveModel: {
    channel: 'penmoss:meaning:remove-model',
    from: 'main',
    gesture: { refused: null },
  },
  // Recreate Index… and Delete Index… (A1595): as Delete Model…, after the click that confirms.
  meaningRemoveIndex: {
    channel: 'penmoss:meaning:remove-index',
    from: 'main',
    gesture: { refused: null },
  },
  // Git notebooks (T50 G3, G5; A853–A857): main runs git, the page runs the engine. Listed to
  // the capture window too, which files captures in the Journal notebook (A827); the token never
  // reaches a page. The owner checks need a person, then Touch ID.
  gitList: { channel: 'penmoss:git:list', from: 'app', refused: [] },
  gitAdd: { channel: 'penmoss:git:add', from: 'window' },
  gitRemove: {
    channel: 'penmoss:git:remove',
    from: 'window',
    gesture: { refused: NEEDS_A_PERSON },
  },
  // Who commits, and a rename, are the person's to set: the handler asks for a gesture for those.
  gitUpdate: { channel: 'penmoss:git:update', from: 'window', gesture: 'handler' },
  gitToken: { channel: 'penmoss:git:token', from: 'window' },
  gitPurgeCheck: {
    channel: 'penmoss:git:purge-check',
    from: 'window',
    gesture: { refused: NEEDS_A_PERSON },
  },
  gitRestoreCheck: {
    channel: 'penmoss:git:restore-check',
    from: 'window',
    gesture: { refused: NEEDS_A_PERSON },
  },
  gitPurgesToConfirm: { channel: 'penmoss:git:purges-to-confirm', from: 'window' },
  gitSecret: { channel: 'penmoss:git:secret', from: 'window' },
  gitOp: { channel: 'penmoss:git:op', from: 'window' },
  gitCancel: { channel: 'penmoss:git:cancel', from: 'window' },
  gitIdentity: { channel: 'penmoss:git:identity', from: 'window' },
  // Browsing GitHub in Add a Git Notebook (T81, A1165): the main window only, where adding is.
  gitGithubRepos: { channel: 'penmoss:git:github-repos', from: 'main' },
  gitGithubFolders: { channel: 'penmoss:git:github-folders', from: 'main' },
  gitGithubOwners: { channel: 'penmoss:git:github-owners', from: 'main' },
  gitGithubCreate: {
    channel: 'penmoss:git:github-create',
    from: 'main',
    gesture: { refused: BROWSE_NEEDS_A_PERSON },
  },
  // Agents on this Mac with no account (T54, A992, A993): the main window's Settings only.
  agentsList: { channel: 'penmoss:agents:list', from: 'main' },
  agentsConnect: {
    channel: 'penmoss:agents:connect',
    from: 'main',
    gesture: { refused: NEEDS_A_PERSON },
  },
  agentsDisconnect: {
    channel: 'penmoss:agents:disconnect',
    from: 'main',
    gesture: { refused: NEEDS_A_PERSON },
  },
  cliStatus: { channel: 'penmoss:cli:status', from: 'main' },
  cliInstall: {
    channel: 'penmoss:cli:install',
    from: 'main',
    gesture: { refused: NEEDS_A_PERSON },
  },
  cliRemove: { channel: 'penmoss:cli:remove', from: 'main', gesture: { refused: NEEDS_A_PERSON } },
  // The capture hotkey (T30): read by any page; changed only from Settings → Quick Capture
  // in a main or note window, after a key press or click (HotkeyChangeGate decides).
  captureHotkey: { channel: 'penmoss:capture:hotkey', from: 'app' },
  captureSetHotkey: { channel: 'penmoss:capture:set-hotkey', from: 'window', gesture: 'handler' },
} as const satisfies { readonly [K in InvokeName]: InvokeRule<InvokeResult<K>> };

/** Every message a page sends main with no answer (`ipcRenderer.send`, `ipcMain.on`). */
export interface Sends {
  /** Each window's own menus; the menu bar shows those of the window in front (A712). */
  menuSet: [menus: readonly DesktopMenu[]];
  /** The theme on screen (T28): kept for the next launch, and painted behind every window. */
  themeSet: [theme: DesktopTheme];
  /** The capture window is done (`saved`: the other windows read the store now). */
  captureDone: [saved: boolean];
  /** A page stored these records (null: too many to name, T45, A711). */
  stored: [ids: readonly string[] | null];
  /** The Quick Access notes the menu bar icon lists, from the main window's page (A946). */
  quickAccessSet: [pins: readonly MenuBarPin[]];
  /** A page's reply to main's ask to store (`save`), by its id (#174 review). */
  saved: [reply: StoreReply];
}

export type SendName = keyof Sends;

export const SEND = {
  menuSet: { channel: 'penmoss:menu:set', from: 'window' },
  themeSet: { channel: 'penmoss:theme:set', from: 'window' },
  captureDone: { channel: 'penmoss:capture:done', from: 'app' },
  stored: { channel: 'penmoss:stored', from: 'app' },
  quickAccessSet: { channel: 'penmoss:quick-access:set', from: 'mac' },
  saved: { channel: 'penmoss:saved', from: null },
} as const satisfies { readonly [K in SendName]: SendRule };

/** Every message main sends a page (`webContents.send`, `ipcRenderer.on`), and what it carries. */
export interface Events {
  menuCommand: MenuCommandEvent;
  /** An in-app path to open (a deep link, a Quick Access note). */
  openPath: string;
  /** Another window stored these records; none: read everything (the capture window's save). */
  storeChanged: readonly string[] | undefined;
  /** Store everything now (`close`: the window closes or the app quits). */
  save: StoreRequest;
  captureShow: undefined;
  windowStateChanged: MacWindowState;
  githubTokenChanged: undefined;
  githubSignInChanged: GitHubSignInState;
  updatesChanged: DesktopUpdateState;
  updatesNotesChanged: DesktopReleaseNotes;
  meaningChanged: DesktopMeaningStatus;
  /** The git notebooks changed (added, removed, a token set): read them again. */
  gitChanged: undefined;
}

export type EventName = keyof Events;

export const EVENT = {
  menuCommand: 'penmoss:menu:command',
  openPath: 'penmoss:open-path',
  storeChanged: 'penmoss:store-changed',
  save: 'penmoss:save',
  captureShow: 'penmoss:capture:show',
  windowStateChanged: 'penmoss:window:state-changed',
  githubTokenChanged: 'penmoss:github-token:changed',
  githubSignInChanged: 'penmoss:github:sign-in-changed',
  updatesChanged: 'penmoss:updates:changed',
  updatesNotesChanged: 'penmoss:updates:notes-changed',
  meaningChanged: 'penmoss:meaning:changed',
  gitChanged: 'penmoss:git:changed',
} as const satisfies { readonly [K in EventName]: string };

/** The argument that tells the preload which window it is in. */
export const WINDOW_ARG = '--penmoss-window=';
export const VERSION_ARG = '--penmoss-version=';
/**
 * The window's title-bar style (`compact` or `native`, T47), passed to main and note windows
 * that have the Mac's window behaviours (A725); absent, the page shows none of them.
 */
export const TITLE_BAR_ARG = '--penmoss-title-bar=';
