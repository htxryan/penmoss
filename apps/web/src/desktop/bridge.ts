/**
 * The Mac app's preload API (T29, apps/desktop/src/preload.ts), as the web
 * app sees it on `window.penmossDesktop`. Absent in a browser. Every call
 * goes to the main process over IPC; the page never gets Node or Electron.
 * Since T59 (D49, A1037) it has no session, sign-in, open-in-browser or admin
 * requests: there is no server to sign in to.
 */
import type {
  BrowseError,
  GitHubOwner,
  GitHubRepo,
  RepoFolders,
  RepoList,
} from '@penmoss/git-notebook/github-browse';

export type {
  BrowseError,
  GitHubOwner,
  GitHubRepo,
  RepoFolder,
  RepoFolders,
  RepoList,
} from '@penmoss/git-notebook/github-browse';

/** One native menu item: a command, its title and its current shortcut. */
export interface DesktopMenuItem {
  readonly id: string;
  readonly title: string;
  /** The command's combinations (`Mod+Shift+E`); the menu shows the first it can. */
  readonly keys: readonly string[];
  /** False when the command cannot run now: the item is greyed out, as a Mac app's are (A526). */
  readonly enabled?: boolean;
  /** A checkbox item, ticked or not (T46: View → Keep on top, A720). Absent: a plain item. */
  readonly checked?: boolean;
}

/** A top-level menu, its items in groups (separators between groups). */
export interface DesktopMenu {
  readonly label: string;
  readonly groups: ReadonlyArray<readonly DesktopMenuItem[]>;
}

export interface MenuCommandEvent {
  readonly id: string;
  /** The menu took the item's shortcut itself (the page may not have seen the key). */
  readonly accelerator: string | null;
}

export interface ClipboardWrite {
  readonly text: string;
  readonly html?: string;
  readonly markdown?: string;
}

export interface CaptureHotkey {
  readonly accelerator: string;
  /** False when another app holds it (the hotkey then does nothing). */
  readonly registered: boolean;
  /** False on a Mac, where another app may take the keys although registering worked. */
  readonly certain: boolean;
}

export interface DesktopTheme {
  readonly light: string;
  readonly dark: string;
  readonly mode: 'light' | 'dark' | 'system';
}

/** A main or note window's own state in the Mac app (T46, T47). */
export interface MacWindowState {
  /** Pinned above other apps' windows (A720). */
  readonly keepOnTop: boolean;
  /** In full screen: the traffic lights hide, and so does the room left for them (A722). */
  readonly fullScreen: boolean;
}

/**
 * The Mac's window behaviours (T46, T47; A720–A725): keep on top and the compact title bar, in
 * main and note windows only. Absent in a browser, the capture window and a Mac app built
 * before T46.
 */
export interface MacWindow {
  /**
   * How this window opened: `compact`, the traffic lights in the app's own first row (A722),
   * or `native`, macOS's title bar (the setting turned off, A724).
   */
  readonly titleBar: 'compact' | 'native';
  state(): Promise<MacWindowState | null>;
  onState(listener: (state: MacWindowState) => void): () => void;
  /** Pins or unpins this window; answers its state after. */
  setKeepOnTop(keepOnTop: boolean): Promise<MacWindowState | null>;
  /**
   * Settings → Appearance → Compact title bar (A724), only just after a key press or click: the
   * app asks first, stores every window's notes, then reopens the windows. Answers whether it
   * is on now, and whether the windows reopen (not when a window could not store its notes:
   * the app says so in a dialog).
   */
  setCompactTitleBar(
    compact: boolean,
  ): Promise<{ readonly compact: boolean; readonly reopened: boolean } | null>;
}

/** A Quick Access note as the menu bar icon's menu lists it (T51, A946): '' for no title. */
export interface MenuBarPin {
  readonly id: string;
  readonly title: string;
}

/**
 * The menu bar icon (T51 item 17, A945): this Mac's own preference, off by default, and the Quick
 * Access notes its menu lists. Main and note windows on a Mac only; `setQuickAccess` in the main
 * window only. Absent in a browser and in a Mac app from before T51.
 */
export interface MenuBar {
  /** Whether the icon shows; null when main refuses to say. */
  shown(): Promise<boolean | null>;
  /** Shows or hides it, only just after a key press or click; answers whether it shows now. */
  setShown(shown: boolean): Promise<boolean | null>;
  /** The Quick Access notes the menu lists, in pin order (A946). */
  setQuickAccess?(pins: readonly MenuBarPin[]): void;
}

/** A note a sync would delete for good, as main names it from the branch (A855). */
export interface GitPendingPurge {
  readonly id: string;
  /** Its title at head ('' for none). */
  readonly title: string;
  /** Confirmed on this Mac once already; false: never, so it cannot be confirmed again. */
  readonly confirmedBefore: boolean;
}

/** A git notebook on this Mac, as main lists it: never its token (T50, A856). */
export interface GitNotebookInfo {
  /** This Mac's id for its clone. */
  readonly localId: string;
  /** The notebook's id (`.penmoss/notebook.json`): its store is `penmoss-git-<id>`. */
  readonly notebookId: string;
  /**
   * The salt of its derived ids when `notebook.json` names one (`''` for the notebook imported
   * from the personal workspace, A1021); absent: the notebook's id.
   */
  readonly salt?: string;
  readonly name: string;
  /**
   * Renamed on this Mac and not yet in `notebook.json` (Ryan's review of PR #192): the engine's
   * window writes it at its next sync. Null or absent: none.
   */
  readonly pendingName?: string | null;
  /** This Mac makes the notebook: the target held none when it was added. */
  readonly create: boolean;
  readonly remote: string;
  /** `github.com/owner/repo`, or the host and path. */
  readonly repository: string;
  readonly host: string;
  readonly branch: string;
  readonly dir: string;
  readonly pushDelayS: number;
  readonly pullEveryMin: number;
  readonly sign: boolean;
  /** This notebook's own commit name and email (#170 F6), or null for git's. */
  readonly author: { readonly name: string; readonly email: string } | null;
  readonly hasToken: boolean;
  /** The host ignored the partial-clone filter: the clone holds every file (A824). */
  readonly filterIgnored: boolean;
}

/** A refusal from the main process, shown as it is (A824: with the host's own words). */
export interface GitRefusal {
  readonly code: string;
  readonly message: string;
  readonly hostMessage?: string;
}

export type GitAnswer<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: GitRefusal };

export type GitAddResult =
  | { readonly kind: 'added'; readonly notebook: GitNotebookInfo; readonly created: boolean }
  | { readonly kind: 'needs-name' };

/**
 * Git notebooks (T50 G3, G5; A853–A857): main runs git and keeps each notebook's token; the page
 * runs the engine. Main and note windows only.
 */
export interface DesktopGit {
  list(): Promise<GitNotebookInfo[]>;
  add(input: {
    readonly remote: string;
    readonly branch: string;
    readonly dir: string;
    readonly name?: string;
    /**
     * Picked through Penmoss's GitHub sign-in (T82, A1171): main gives the notebook that token,
     * for a github.com address over HTTPS.
     */
    readonly githubSignIn?: boolean;
  }): Promise<GitAnswer<GitAddResult> | null>;
  /**
   * Asks the Mac's owner first (Touch ID); only just after a key press or click. `unpushed`:
   * how many notes have changes not pushed (null: not known), which the owner check names.
   */
  remove(
    localId: string,
    unpushed: number | null,
  ): Promise<GitAnswer<{ readonly notebookId: string }> | null>;
  update(
    localId: string,
    patch: {
      readonly pushDelayS?: number;
      readonly pullEveryMin?: number;
      readonly sign?: boolean;
      readonly tokenUser?: string | null;
      /** This notebook's own commit identity; null goes back to git's (#170 F6). */
      readonly author?: { readonly name: string; readonly email: string } | null;
      /** Rename (after a gesture): written to `notebook.json` at the next sync, on every device. */
      readonly name?: string;
      /** The name a sync found in `notebook.json` (another device's rename, or this one landing). */
      readonly branchName?: string;
    },
  ): Promise<GitAnswer<GitNotebookInfo> | null>;
  /** Written only: the token never comes back (A857). Null forgets it. */
  setToken(localId: string, token: string | null): Promise<GitAnswer<null> | null>;
  /**
   * Delete for good of one note asks the Mac's owner first (D34, A828); main then lets a commit
   * delete that note for good, and no other, for 10 minutes (A855). A list confirms again, in one
   * check, those of its notes not deleted on the branch yet whose confirmation ran out; main
   * refuses the whole list if any note in it was never confirmed on this Mac.
   */
  purgeCheck(localId: string, noteId: string | readonly string[]): Promise<GitAnswer<null> | null>;
  /**
   * History's restore or revert asks the Mac's owner first, naming the note from the branch, as
   * Android's does (A877, A901). Nothing is recorded: the page waits for the answer.
   */
  restoreCheck(localId: string, noteId: string, revert: boolean): Promise<GitAnswer<null> | null>;
  /**
   * What confirming Delete for good again would take, named by main from the branch (A855);
   * `also` adds notes by id (listed unless deleted for good on the branch).
   */
  purgesToConfirm(
    localId: string,
    also?: readonly string[],
  ): Promise<GitAnswer<readonly GitPendingPurge[]> | null>;
  writerSecret(localId: string, value?: string): Promise<GitAnswer<string | null> | null>;
  /** One transport call for the engine (A836): main checks its arguments first. */
  op(localId: string, op: string, args: readonly unknown[]): Promise<GitAnswer<unknown> | null>;
  /** Stops every git of the notebook now (a sync out of time, A852); resolves once stopped. */
  cancel(localId: string): Promise<unknown>;
  identity(): Promise<{ readonly name: string; readonly email: string } | null>;
  /** The list changed (added, removed, a token set): read it again. */
  onChange(listener: () => void): () => void;
  /** Agents connected to this notebook on this Mac: their clones in `~/.penmoss` (T54, A993). */
  agents(localId: string): Promise<GitAnswer<readonly LocalAgentInfo[]> | null>;
  /** Connect an Agent: Touch ID, then the agent's own clone; only just after a click (A993). */
  connectAgent(localId: string, label: string): Promise<GitAnswer<LocalAgentInfo> | null>;
  /**
   * Removes an agent's clone; refuses `unsynced_changes` when it has changes not pushed. `force`
   * loses them, after Touch ID. Only just after a click.
   */
  disconnectAgent(name: string, force: boolean): Promise<GitAnswer<null> | null>;
  /** The `penmoss` command on this Mac (A992). */
  cli(): Promise<CliInfo | null>;
  /** Writes `~/.local/bin/penmoss`; never over another program's. Only just after a click. */
  installCli(): Promise<GitAnswer<CliInfo> | null>;
  removeCli(): Promise<GitAnswer<CliInfo> | null>;
  /** Browsing GitHub in Add a Git Notebook (T81, A1165): the main window only; absent in older builds. */
  readonly github?: DesktopGitHubBrowse;
}

/** Which sign-in a browse call used: git's own, or Penmoss's (T82). */
export type GitHubVia = 'git' | 'penmoss';

export type GitHubAnswer<T> =
  | { readonly ok: true; readonly value: T; readonly via: GitHubVia }
  | { readonly ok: false; readonly error: BrowseError };

/**
 * GitHub as Add a Git Notebook browses it (T81): main asks git for its credential on each call
 * and the page never sees it. Null from a window that may not browse.
 */
export interface DesktopGitHubBrowse {
  repos(): Promise<GitHubAnswer<RepoList> | null>;
  folders(fullName: string, branch: string): Promise<GitHubAnswer<RepoFolders> | null>;
  owners(): Promise<GitHubAnswer<readonly GitHubOwner[]> | null>;
  /** Makes an empty private repository; only just after a click. */
  create(owner: GitHubOwner, name: string): Promise<GitHubAnswer<GitHubRepo> | null>;
  /** Sign in with GitHub (T82, A1170); absent in older builds. */
  readonly signIn?: DesktopGitHubSignIn;
}

/** What the page may know of a sign-in (A1170): never the device code or the token. */
export type GitHubSignInState =
  | { readonly state: 'idle' }
  | {
      readonly state: 'waiting';
      /** The code to enter on GitHub, `WDJB-MJHT`. */
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresAt: number;
    }
  | { readonly state: 'signed-in'; readonly login: string | null }
  | { readonly state: 'denied' }
  | { readonly state: 'expired' }
  | { readonly state: 'cancelled' }
  | { readonly state: 'failed'; readonly message: string };

/** GitHub's device sign-in for Penmoss's OAuth app, run in main (T82). */
export interface DesktopGitHubSignIn {
  /** `available` is false in a build without Penmoss's OAuth app: then no Sign in button. */
  status(): Promise<{
    readonly available: boolean;
    readonly state: GitHubSignInState;
    /** The account Penmoss's GitHub token is for, when one is kept. */
    readonly login: string | null;
  } | null>;
  /** Asks GitHub for a code and opens github.com/login/device; only just after a click. */
  start(): Promise<GitHubSignInState | GitAnswer<never> | null>;
  cancel(): Promise<unknown>;
  onChange(listener: (state: GitHubSignInState) => void): () => void;
}

/** An agent connected to a git notebook on this Mac, and how to give it the MCP server (A993). */
export interface LocalAgentInfo {
  /** Its clone's name: `penmoss … --notebook <name>`. */
  readonly name: string;
  readonly label: string;
  /** The app made it by itself, for every agent on this Mac (D52): it goes with the notebook. */
  readonly automatic?: boolean;
  /** The MCP server's name in the agent's configuration. */
  readonly server: string;
  /** `claude mcp add …`, for a terminal. */
  readonly claude: string;
  /** The same with `--channel`: it also brings the comments sent to this agent (T60, A1073). */
  readonly claudeChannel: string;
  /** `claude --dangerously-load-development-channels server:<server>`, to start Claude Code. */
  readonly claudeLaunch: string;
  /** The lines for Codex's `~/.codex/config.toml`. */
  readonly codex: string;
}

/** The `penmoss` command the app writes (A992). */
export interface CliInfo {
  readonly path: string;
  /** `stale`: the app's script, for another copy of the app; `other`: not the app's. */
  readonly state: 'installed' | 'stale' | 'missing' | 'other';
  /** Whether a terminal's PATH has its folder; null when not known. */
  readonly onPath: boolean | null;
  readonly pathLine: string;
  readonly profile: string;
  /** The app's binary with the switch: runs the CLI without the script. */
  readonly direct: string;
}

export interface PenmossDesktop {
  readonly platform: string;
  readonly version: string;
  /**
   * Which window this page is: the main window, a note window (T45, A712) or the capture
   * window.
   */
  readonly window: 'main' | 'note' | 'capture';
  readonly menu: {
    set(menus: readonly DesktopMenu[]): void;
    onCommand(listener: (event: MenuCommandEvent) => void): () => void;
    /**
     * What main held until this main window's page listened (T51, A945): a command id (the menu
     * bar icon's Open Today's Journal), a path to show (a Quick Access note, a deep link), or
     * null. Asking also tells main the page listens now. Optional: a Mac app before T51 does
     * not have it.
     */
    takePending?(): Promise<string | { readonly path: string } | null>;
  };
  /**
   * The theme on screen (T28): its two backgrounds and the mode. The windows
   * behind the page take the variant macOS shows, and the next launch opens in it.
   * Optional: a Mac app built before T28 does not have it.
   */
  readonly theme?: {
    set(theme: DesktopTheme): void;
  };
  readonly macWindow?: MacWindow;
  readonly menuBar?: MenuBar;
  /**
   * Git notebooks (T50): absent in a browser and older Mac apps. The capture window has `list`
   * and `onChange` only: it files captures in the Journal notebook and never runs an engine.
   */
  readonly git?: DesktopGit;
  /**
   * Send feedback (T49, A798): `capturePage()` of this window as a PNG, taken as the form
   * opens, so it shows the screen behind the form. Null when it could not be taken. Absent in a
   * browser and in a Mac app from before T49.
   */
  readonly feedback?: {
    capture(): Promise<Uint8Array | null>;
    /**
     * Files the outbox's entry with the person's GitHub token, in the main process (T57, A1010):
     * the payload part and each screenshot's bytes. Answers the Worker's statuses and body.
     * Absent in a Mac app from before T57.
     */
    file?(
      payload: string,
      screenshots: ReadonlyArray<{ readonly type: string; readonly bytes: Uint8Array }>,
    ): Promise<DesktopFeedbackAnswer | null>;
  };
  /** The person's own GitHub token (T57, A1012): never read back. Absent before T57. */
  readonly githubToken?: DesktopGitHubToken;
  /** Auto-Update (T64 item 2, A1112): main windows only. Absent in a Mac app from before T64. */
  readonly updates?: DesktopUpdates;
  /** Search by meaning (T76): main and note windows. Absent in a Mac app from before T76. */
  readonly meaning?: DesktopMeaning;
  readonly clipboard: {
    /** Only just after a key press or click, or a menu command (false otherwise). */
    write(data: ClipboardWrite): Promise<boolean>;
  };
  /**
   * Runs `save` before the window closes or the app quits, so the last
   * keystrokes are stored (the app waits up to 3 s).
   */
  /** `close`: a window closes or the app quits; `flush`: store only (#174 review). */
  onBeforeClose(save: (reason: 'close' | 'flush') => Promise<void>): () => void;
  /**
   * Another window stored changes: read them from IndexedDB. `ids` names the records it wrote
   * (T45, A711); absent, read everything (the capture window's save).
   */
  onStoreChanged(listener: (ids?: readonly string[]) => void): () => void;
  /**
   * This window stored these records (null: too many to name): the main process tells every
   * other window (T45, A711). Absent in a Mac app from before T45.
   */
  stored?(ids: readonly string[] | null): void;
  /** In-app paths to open (deep links: `penmoss://note/<id>`). */
  onOpenPath(listener: (path: string) => void): () => void;
  readonly capture: {
    /** Hides the capture window (after Escape, or a save: `saved` tells the main window). */
    done(saved: boolean): void;
    onShow(listener: () => void): () => void;
    hotkey(): Promise<CaptureHotkey>;
    setHotkey(accelerator: string): Promise<CaptureHotkey & { readonly error?: string }>;
  };
}

declare global {
  interface Window {
    penmossDesktop?: PenmossDesktop;
  }
}

/** What filing feedback answered (core's `FeedbackAnswer`). */
export interface DesktopFeedbackAnswer {
  readonly status: number;
  readonly body:
    | { readonly issue: { readonly number: number; readonly url: string } }
    | { readonly error: { readonly code: string; readonly message: string } };
  readonly retryAfter?: number;
}

export interface DesktopGitHubTokenStatus {
  readonly saved: boolean;
  readonly login: string | null;
  readonly problem: string | null;
  readonly keychain: boolean;
  /** From Sign in with GitHub (T82), not pasted; absent from older builds. */
  readonly signedIn?: boolean;
}

export interface DesktopGitHubToken {
  status(): Promise<DesktopGitHubTokenStatus | null>;
  /** After a key press or click only. */
  save(
    token: string,
  ): Promise<
    | { readonly ok: true; readonly status: DesktopGitHubTokenStatus; readonly note: string | null }
    | { readonly ok: false; readonly message: string }
    | null
  >;
  remove(): Promise<
    | { readonly ok: true; readonly status: DesktopGitHubTokenStatus }
    | { readonly ok: false; readonly message: string }
    | null
  >;
  onChange(listener: () => void): () => void;
}

export type DesktopUpdatePhase =
  'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';

/** Where updates come from (A1196): stable releases, or every build from main. */
export type DesktopUpdateChannel = 'stable' | 'alpha';

/** Auto-Update as main has it (apps/desktop/src/updater.ts `UpdateState`). */
export interface DesktopUpdateState {
  /** A signed build: it can check and install. */
  readonly supported: boolean;
  /** Checks at launch and every hour. */
  readonly auto: boolean;
  /** Stable (the default) or Alpha. */
  readonly channel: DesktopUpdateChannel;
  /** This app's version: `X.Y.Z`, `X.Y.Z-alpha.<run>`, or `0.1.<build>` from before. */
  readonly current: string;
  readonly phase: DesktopUpdatePhase;
  /** The newer build's version, once one is found. */
  readonly version: string | null;
  readonly percent: number | null;
  readonly message: string | null;
  readonly checkedAt: number | null;
  /**
   * The version before this one, on the first launches of a newer version until the notice is
   * answered (PEN-110). Absent in a Mac app from before PEN-110.
   */
  readonly updatedFrom?: string | null;
}

export interface DesktopUpdates {
  state(): Promise<DesktopUpdateState | null>;
  check(): Promise<DesktopUpdateState | null>;
  /** After a key press or click only (null otherwise). */
  setAuto(on: boolean): Promise<DesktopUpdateState | null>;
  /** After a key press or click only: keeps the channel and checks it at once. */
  setChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateState | null>;
  /** After a key press or click only: downloads the newer build, then restarts into it. */
  install(): Promise<DesktopUpdateState | null>;
  /**
   * After a click only: the notice after an update was answered, so it doesn't come back
   * (PEN-110). Absent in a Mac app from before PEN-110.
   */
  acknowledge?(): Promise<DesktopUpdateState | null>;
  onChange(listener: (state: DesktopUpdateState) => void): () => void;
  /**
   * The cached `release-notes.json` (PEN-108), null before main has one; asking also fetches a
   * newer one, at most once an hour. Absent in a Mac app from before PEN-108.
   */
  notes?(): Promise<DesktopReleaseNotes | null>;
  /** A newer `release-notes.json` came in. Absent in a Mac app from before PEN-108. */
  onNotes?(listener: (file: DesktopReleaseNotes) => void): () => void;
}

/** One release note (apps/desktop/src/release-notes.ts `ReleaseNote`). */
export interface DesktopReleaseNote {
  /** The build that merged it. */
  readonly build: number;
  readonly pr: number;
  readonly kind: 'new' | 'improved' | 'fixed';
  /** Only on one platform; null for both. */
  readonly platform: 'mac' | 'android' | null;
  readonly text: string;
}

/** A published stable release, as the notes place it. */
export interface DesktopReleaseNotesRelease {
  readonly version: string;
  readonly tag: string;
  readonly build: number;
  readonly date: string;
}

/** `release-notes.json` as main hands it over (apps/desktop/src/release-notes.ts). */
export interface DesktopReleaseNotes {
  /** 1; a newer schema comes with no notes, and the page links to GitHub. */
  readonly schema: number;
  readonly generated: string;
  readonly notes: readonly DesktopReleaseNote[];
  readonly releases: readonly DesktopReleaseNotesRelease[];
}

/** Where the embedding service is (T76, A1158): Settings → Search by Meaning shows it. */
export type DesktopMeaningState =
  | 'off'
  | 'absent'
  | 'downloading'
  | 'opening'
  | 'indexing'
  | 'ready'
  | 'failed'
  | 'starting'
  | 'restarting'
  | 'stopped';

export interface DesktopMeaningStatus {
  readonly state: DesktopMeaningState;
  /** Which start of the service this is: a new one has none of the notes sent before. */
  readonly generation: number;
  readonly enabled: boolean;
  readonly model?: string;
  /** The model's bytes on this Mac, of `totalBytes`; `received` while downloading. */
  readonly modelBytes?: number;
  readonly totalBytes?: number;
  readonly received?: number;
  readonly license?: { readonly name: string; readonly url: string };
  /** Notes with vectors, of the notes sent. */
  readonly indexed: number;
  readonly total: number;
  /** Another copy of the app holds the indexing lease (A1350): this one only searches. */
  readonly leaseElsewhere?: boolean;
  readonly error?: string;
}

/** A note as the page sends it: sections only when the service asked for them. */
export interface DesktopMeaningNote {
  readonly id: string;
  readonly version: string | number;
  readonly title?: string;
  readonly sections?: ReadonlyArray<{
    readonly heading: string | null;
    readonly path: readonly string[];
    readonly text: string;
  }>;
}

export interface DesktopMeaningHit {
  readonly id: string;
  readonly score: number;
  readonly heading: string | null;
  readonly preview: string;
}

export interface DesktopMeaning {
  /** Null where the service does not run. */
  status(): Promise<DesktopMeaningStatus | null>;
  /** Every note of one notebook with its version: answers the ids to send with sections. */
  update(notebookId: string, notes: readonly DesktopMeaningNote[]): Promise<string[]>;
  close(notebookId: string): Promise<void>;
  /** Meaning's hits and its floor (A1155), or null: then search by words alone. */
  search(
    notebookId: string,
    query: string,
    options?: { readonly limit?: number; readonly ids?: readonly string[] },
  ): Promise<{ readonly floor: number; readonly hits: DesktopMeaningHit[] } | null>;
  /** After a key press or click only, main window only (null otherwise; A1158). */
  setEnabled(on: boolean): Promise<DesktopMeaningStatus | null>;
  onChange(listener: (status: DesktopMeaningStatus) => void): () => void;
}

export function desktop(): PenmossDesktop | null {
  return typeof window === 'undefined' ? null : (window.penmossDesktop ?? null);
}
