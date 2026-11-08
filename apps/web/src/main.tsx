import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CaptureWindow } from './capture/CaptureWindow';
import { desktop } from './desktop/bridge';
import { startTitleBar } from './desktop/mac-window';
import { NoteDirectory } from './notes/directory';
import type { Notes } from './notes/service';
import { FirstRunGate } from './sources/FirstRun';
import { RootScope } from './sources/RootScope';
import { SourcesProvider } from './sources/context';
import { GIT_STATUS_CHANNEL } from './sources/git-source';
import { Sources } from './sources/registry';
import { errorRing } from './feedback/errors';
import { FeedbackContext, FeedbackService } from './feedback/service';
import { installModalFocusTrap } from './shell/focus-trap';
import './theme/defaults.css';
import './styles.css';
import './blocks.css';
import './links.css';
import './search/search.css';
import './feedback/feedback.css';
import './theme/theme.css';
import { isNoteWindowPath, navigate, startHistory } from './router';
import { openNoteWindow } from './window/open';
import { browserChannel, StorePuller, storeSync } from './window/store-sync';
import { browserThemeEnvironment, ThemeController } from './theme/controller';
import { ThemeProvider } from './theme/ThemeProvider';
import type { Workspace } from './workspace/service';

// Before anything renders: the theme this device last showed (T28); the notebook's choice
// replaces it once its workspace has been read.
const theme = new ThemeController(browserThemeEnvironment());
theme.start();

// Tab stays inside an open modal dialog (T39).
installModalFocusTrap(document);

// Back and Forward know where this window's history starts (a note window's, T45).
startHistory();

// The Mac app's compact title bar (T47, A722): room for the traffic lights from the first paint.
startTitleBar(document.documentElement);

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root element in index.html');
}

const bridge = desktop();
// The last errors, for Send feedback's context (T49, A791); in memory only.
errorRing.install(window);
// The capture window and note windows (T45) show no folder notice, so they leave one to the
// main window (A676).
const noteWindow = bridge?.window === 'note' || isNoteWindowPath(window.location.pathname);
// What another window stores shows here at once, offline too: a capture saved in the Mac app's
// capture window (T30), an edit in a note window (T45, A711).
const windows = storeSync({ bridge, channel: browserChannel() });

// Wikilinks (T16): the registry as links see it, offline included; each source has its own.
const makeDirectory = (notes: Notes, workspace: Workspace) =>
  new NoteDirectory({
    notes,
    folderOf: (id) =>
      workspace.getState().snapshot.notes.find((entry) => entry.id === id)?.folderId ?? null,
    folderName: (id) =>
      workspace.getState().snapshot.folders.find((folder) => folder.id === id)?.name ?? null,
    pathOf: (id) =>
      workspace.getState().snapshot.notes.find((entry) => entry.id === id)?.path ?? null,
    register: (id, folderId) => workspace.registerNote(id, folderId),
    navigate,
    openTab: (path) => window.open(path, '_blank', 'noopener'),
    // ⌥-click (T45, A710).
    openWindow: (id, heading) => openNoteWindow(id, heading),
  });

const browserStore = (() => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
})();
// Each git notebook on this Mac, side by side (T50, A862); the only kind (D48, A1030). The
// capture window lists them only (it never runs an engine; its captures reach the engine's
// window through the store, A822).
const sources = new Sources({
  git: bridge?.git ?? null,
  gitDeps: {
    directory: makeDirectory,
    // The window that holds a notebook's lock runs its engine (A822): never the capture window.
    canHost: bridge?.window !== 'capture',
    notices: !noteWindow,
    locks: typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null,
    channel:
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(GIT_STATUS_CHANNEL),
    log: (message, error) => console.warn(`[git] ${message}`, error ?? ''),
  },
  sync: windows,
  storage: browserStore,
});
await sources.load().catch((error: unknown) => console.warn('[git] could not list', error));
// Another window's stored records (`<notebook>/<id>`) go to their notebook.
const puller = new StorePuller((ids) => sources.storedElsewhere(ids));
windows.onChanged((ids) => puller.changed(ids));
// A closing window announces what it stored in its last moments.
window.addEventListener('pagehide', () => windows.flush());
// The Mac app closes a window only once its notes and folders are stored (T29), and each git
// notebook has synced once if it can (A825). Main asks for `flush` before the capture window
// reads the store or a title bar change: then nothing syncs (#174 review).
bridge?.onBeforeClose(async (reason) => {
  await sources.store(reason);
  // The other windows hear this window's last writes before it goes (before `saved`).
  windows.flush();
});

// Send feedback (T49): its outbox sends what waits, here and when back online. Its sync facts
// are the Journal notebook's (the app's own, A827).
const rootNotes = () => sources.getState().root?.notes ?? null;
const feedback = new FeedbackService({
  syncState: () => rootNotes()?.syncState() ?? { phase: 'syncing', pending: 0, detail: null },
  subscribeSync: (listener) => {
    let offNotes = rootNotes()?.subscribeSync(listener) ?? null;
    const offSources = sources.subscribe(() => {
      offNotes?.();
      offNotes = rootNotes()?.subscribeSync(listener) ?? null;
      listener();
    });
    return () => {
      offSources();
      offNotes?.();
    };
  },
});
if (bridge?.window !== 'capture') feedback.start(window);

const capture = bridge?.window === 'capture';
createRoot(container).render(
  <StrictMode>
    <SourcesProvider sources={sources}>
      <FeedbackContext.Provider value={feedback}>
        <FirstRunGate capture={capture}>
          <RootScope>
            <ThemeProvider controller={theme}>
              {capture ? <CaptureWindow /> : <App />}
            </ThemeProvider>
          </RootScope>
        </FirstRunGate>
      </FeedbackContext.Provider>
    </SourcesProvider>
  </StrictMode>,
);
