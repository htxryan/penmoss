/**
 * The page's only door to the Mac app (T29): a few named calls over IPC,
 * exposed as `window.penmossDesktop` through the context bridge. No Node,
 * no Electron objects, no raw ipcRenderer reach the page; listeners receive
 * plain data. Types: apps/web/src/desktop/bridge.ts.
 *
 * Calls that need a person behind them (the clipboard, the capture hotkey)
 * carry `navigator.userActivation.isActive`, read here in the isolated world
 * where a page script cannot change it; the main process decides with it.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, TITLE_BAR_ARG, VERSION_ARG, WINDOW_ARG } from './channels';
import { StoreAnswers } from './store-requests';

const arg = (prefix: string) =>
  process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? '';

/** Whether the page has just had a key press or click (transient user activation). */
const gesture = () => navigator.userActivation?.isActive === true;

/** Subscribes to a main-process event; returns the unsubscribe. */
function on<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
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

contextBridge.exposeInMainWorld('penmossDesktop', {
  platform: process.platform,
  version: arg(VERSION_ARG),
  window: windowKind,
  menu: {
    set: (menus: unknown) => ipcRenderer.send(CHANNELS.menuSet, menus),
    onCommand: (listener: (event: unknown) => void) => on(CHANNELS.menuCommand, listener),
    takePending: () => ipcRenderer.invoke(CHANNELS.menuCommandPending),
  },
  theme: {
    set: (theme: unknown) => ipcRenderer.send(CHANNELS.themeSet, theme),
  },
  clipboard: {
    write: (data: unknown) => ipcRenderer.invoke(CHANNELS.clipboardWrite, data, gesture()),
  },
  // Send feedback (T49, A798): the window as it is now, as PNG bytes (or null), taken by the main
  // process with capturePage before the form is drawn. Main and note windows only.
  ...(windowKind !== 'capture'
    ? {
        feedback: {
          capture: () => ipcRenderer.invoke(CHANNELS.feedbackCapture),
          // Filed by main with the person's GitHub token (T57, A1010): the payload part and the
          // screenshots' bytes, as the outbox keeps them.
          file: (payload: string, screenshots: unknown) =>
            ipcRenderer.invoke(CHANNELS.feedbackFile, String(payload), screenshots),
        },
        // The person's GitHub token (A1012): saved and removed after a gesture; never read back.
        githubToken: {
          status: () => ipcRenderer.invoke(CHANNELS.githubTokenStatus),
          save: (token: string) =>
            ipcRenderer.invoke(CHANNELS.githubTokenSave, String(token), gesture()),
          remove: () => ipcRenderer.invoke(CHANNELS.githubTokenRemove, gesture()),
          onChange: (listener: () => void) => on(CHANNELS.githubTokenChanged, () => listener()),
        },
        // Search by meaning (T76, A1152): main relays each call to the embedding service. The
        // switch (A1158) carries the gesture; main takes it from the main window only.
        meaning: {
          status: () => ipcRenderer.invoke(CHANNELS.meaningStatus),
          update: (notebookId: string, notes: unknown) =>
            ipcRenderer.invoke(CHANNELS.meaningUpdate, String(notebookId), notes),
          close: (notebookId: string) =>
            ipcRenderer.invoke(CHANNELS.meaningClose, String(notebookId)),
          search: (notebookId: string, query: string, options: unknown) =>
            ipcRenderer.invoke(CHANNELS.meaningSearch, String(notebookId), String(query), options),
          setEnabled: (value: boolean) =>
            ipcRenderer.invoke(CHANNELS.meaningSetEnabled, value === true, gesture()),
          onChange: (listener: (status: unknown) => void) =>
            on(CHANNELS.meaningChanged, (status) => listener(status)),
        },
        // Auto-Update (T64 item 2, A1112, A1196): the switch, the channel and Install and Restart
        // carry the gesture.
        updates: {
          state: () => ipcRenderer.invoke(CHANNELS.updatesState),
          check: () => ipcRenderer.invoke(CHANNELS.updatesCheck),
          setAuto: (value: boolean) =>
            ipcRenderer.invoke(CHANNELS.updatesSetAuto, value === true, gesture()),
          setChannel: (value: string) =>
            ipcRenderer.invoke(
              CHANNELS.updatesSetChannel,
              value === 'alpha' ? 'alpha' : 'stable',
              gesture(),
            ),
          install: () => ipcRenderer.invoke(CHANNELS.updatesInstall, gesture()),
          onChange: (listener: (state: unknown) => void) =>
            on(CHANNELS.updatesChanged, (state) => listener(state)),
          // Release notes (PEN-108): main's cached file; asking fetches a newer one.
          notes: () => ipcRenderer.invoke(CHANNELS.updatesNotes),
          onNotes: (listener: (file: unknown) => void) =>
            on(CHANNELS.updatesNotesChanged, (file) => listener(file)),
        },
      }
    : {}),
  // Git notebooks (T50 G3, G5; A853–A857): main runs git and keeps each notebook's token; the
  // page's engine calls git through `op`. The owner checks (Remove, Delete for good) carry the
  // gesture: main refuses without one, then asks Touch ID. Main and note windows only.
  // The capture window lists them only, to file captures in the Journal notebook (A827).
  ...(windowKind === 'capture'
    ? {
        git: {
          list: () => ipcRenderer.invoke(CHANNELS.gitList),
          onChange: (listener: () => void) => on(CHANNELS.gitChanged, () => listener()),
        },
      }
    : {}),
  ...(windowKind !== 'capture'
    ? {
        git: {
          list: () => ipcRenderer.invoke(CHANNELS.gitList),
          add: (input: unknown) => ipcRenderer.invoke(CHANNELS.gitAdd, input),
          remove: (localId: string, unpushed: number | null) =>
            ipcRenderer.invoke(
              CHANNELS.gitRemove,
              String(localId),
              typeof unpushed === 'number' ? unpushed : null,
              gesture(),
            ),
          update: (localId: string, patch: unknown) =>
            ipcRenderer.invoke(CHANNELS.gitUpdate, String(localId), patch, gesture()),
          setToken: (localId: string, token: string | null) =>
            ipcRenderer.invoke(
              CHANNELS.gitToken,
              String(localId),
              token === null ? null : String(token),
            ),
          restoreCheck: (localId: string, noteId: string, revert: boolean) =>
            ipcRenderer.invoke(
              CHANNELS.gitRestoreCheck,
              String(localId),
              String(noteId),
              revert === true,
              gesture(),
            ),
          purgeCheck: (localId: string, noteId: string | readonly string[]) =>
            ipcRenderer.invoke(
              CHANNELS.gitPurgeCheck,
              String(localId),
              Array.isArray(noteId) ? noteId.map(String) : String(noteId),
              gesture(),
            ),
          purgesToConfirm: (localId: string, also?: readonly string[]) =>
            ipcRenderer.invoke(
              CHANNELS.gitPurgesToConfirm,
              String(localId),
              Array.isArray(also) ? also.map(String) : [],
            ),
          writerSecret: (localId: string, value?: string) =>
            ipcRenderer.invoke(CHANNELS.gitSecret, String(localId), value),
          op: (localId: string, op: string, args: unknown) =>
            ipcRenderer.invoke(CHANNELS.gitOp, String(localId), String(op), args),
          cancel: (localId: string) => ipcRenderer.invoke(CHANNELS.gitCancel, String(localId)),
          identity: () => ipcRenderer.invoke(CHANNELS.gitIdentity),
          onChange: (listener: () => void) => on(CHANNELS.gitChanged, () => listener()),
          // Browsing GitHub in Add a Git Notebook (T81, A1165): main answers the main window only.
          github: {
            repos: () => ipcRenderer.invoke(CHANNELS.gitGithubRepos),
            folders: (fullName: string, branch: string) =>
              ipcRenderer.invoke(CHANNELS.gitGithubFolders, String(fullName), String(branch)),
            owners: () => ipcRenderer.invoke(CHANNELS.gitGithubOwners),
            create: (owner: { login: string; kind: string }, name: string) =>
              ipcRenderer.invoke(
                CHANNELS.gitGithubCreate,
                { login: String(owner?.login), kind: String(owner?.kind) },
                String(name),
                gesture(),
              ),
            // Sign in with GitHub (T82, A1170): the code to enter and the outcome, never the token.
            signIn: {
              status: () => ipcRenderer.invoke(CHANNELS.githubSignInStatus),
              start: () => ipcRenderer.invoke(CHANNELS.githubSignInStart, gesture()),
              cancel: () => ipcRenderer.invoke(CHANNELS.githubSignInCancel),
              onChange: (listener: (state: unknown) => void) =>
                on(CHANNELS.githubSignInChanged, (state) => listener(state)),
            },
          },
          // Agents on this Mac (T54, A992, A993): main refuses them outside the main window.
          agents: (localId: string) => ipcRenderer.invoke(CHANNELS.agentsList, String(localId)),
          connectAgent: (localId: string, label: string) =>
            ipcRenderer.invoke(CHANNELS.agentsConnect, String(localId), String(label), gesture()),
          disconnectAgent: (name: string, force: boolean) =>
            ipcRenderer.invoke(CHANNELS.agentsDisconnect, String(name), force === true, gesture()),
          cli: () => ipcRenderer.invoke(CHANNELS.cliStatus),
          installCli: () => ipcRenderer.invoke(CHANNELS.cliInstall, gesture()),
          removeCli: () => ipcRenderer.invoke(CHANNELS.cliRemove, gesture()),
        },
      }
    : {}),
  ...(windowKind !== 'capture' && titleBar
    ? {
        macWindow: {
          titleBar,
          // This window's keep-on-top and full-screen state, and its changes.
          state: () => ipcRenderer.invoke(CHANNELS.windowState),
          onState: (listener: (state: unknown) => void) =>
            on(CHANNELS.windowStateChanged, listener),
          setKeepOnTop: (keepOnTop: boolean) =>
            ipcRenderer.invoke(CHANNELS.keepOnTop, keepOnTop === true),
          // Settings → Appearance, after a key press or click: main asks first, stores every
          // window's notes, then reopens the windows (A724).
          setCompactTitleBar: (compact: boolean) =>
            ipcRenderer.invoke(CHANNELS.compactTitleBar, compact === true, gesture()),
        },
      }
    : {}),
  // The menu bar icon (T51 item 17, A945): on a Mac (or the suite standing in for one), in main
  // and note windows. Settings → Display turns it on or off, after a key press or click; the
  // main window's page sends the Quick Access notes its menu lists (A946), ids and titles only.
  ...(windowKind !== 'capture' && titleBar
    ? {
        menuBar: {
          shown: () => ipcRenderer.invoke(CHANNELS.menuBarIconGet),
          setShown: (shown: boolean) =>
            ipcRenderer.invoke(CHANNELS.menuBarIconSet, shown === true, gesture()),
          ...(windowKind === 'main'
            ? {
                setQuickAccess: (pins: unknown) =>
                  ipcRenderer.send(CHANNELS.quickAccessSet, Array.isArray(pins) ? pins : []),
              }
            : {}),
        },
      }
    : {}),
  // `saved` says whether the page stored everything (A724: a window reopens only then).
  // `close` as a window closes or the app quits, else `flush`: store only (#174 review).
  // Each ask has an id, and the reply carries it; a flush waits for a close already running
  // (#174 delta review).
  onBeforeClose: (save: (reason: 'close' | 'flush') => Promise<void>) => {
    const answers = new StoreAnswers(save);
    return on<unknown>(CHANNELS.save, (request) => {
      void answers.answer(request).then((reply) => {
        if (reply) ipcRenderer.send(CHANNELS.saved, reply);
      });
    });
  },
  // Another window stored records (their ids, T45, A711; none: read everything).
  onStoreChanged: (listener: (ids?: readonly string[]) => void) =>
    on<readonly string[] | undefined>(CHANNELS.storeChanged, (ids) =>
      listener(Array.isArray(ids) ? ids : undefined),
    ),
  stored: (ids: unknown) => ipcRenderer.send(CHANNELS.stored, Array.isArray(ids) ? ids : null),
  onOpenPath: (listener: (path: string) => void) => on(CHANNELS.openPath, listener),
  capture: {
    done: (saved: boolean) => ipcRenderer.send(CHANNELS.captureDone, saved === true),
    onShow: (listener: () => void) => on(CHANNELS.captureShow, () => listener()),
    hotkey: () => ipcRenderer.invoke(CHANNELS.captureHotkey),
    setHotkey: (accelerator: string) =>
      ipcRenderer.invoke(CHANNELS.captureSetHotkey, String(accelerator), gesture()),
  },
});
