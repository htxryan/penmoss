import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CaptureWindow } from './capture/CaptureWindow';
import { desktop } from './desktop/bridge';
import { startTitleBar } from './desktop/mac-window';
import { NoteDirectory } from './notes/directory';
import type { Notes } from './notes/service';
import { FirstRunGate } from './sources/FirstRun';
import { JournalScope } from './sources/JournalScope';
import { SourcesProvider } from './sources/context';
import { GIT_STATUS_CHANNEL } from './sources/git-source';
import { Sources } from './sources/registry';
import { errorRing } from './feedback/errors';
import { FeedbackContext, FeedbackService } from './feedback/service';
import { deviceStorage } from './shell/device-pref';
import { installModalFocusTrap } from './shell/focus-trap';
import { installClickTracking } from './analytics/track';
import { installMainTabs } from './tabs/controller';
import { shownNotes } from './tabs/state';
import { setTabNotes } from './notes/kept-editors';
import './theme/defaults.css';
import './styles.css';
import './blocks.css';
import './links.css';
import './search/search.css';
import './feedback/feedback.css';
import './theme/theme.css';
import { hasTabs, isNoteWindowPath, navigate, openPath, startHistory } from './router';
import { openNoteWindow, setStoreBeforeNoteWindow } from './window/open';
import { StorePuller, storeSync } from './window/store-sync';
import { browserThemeEnvironment, ThemeController } from './theme/controller';
import { ThemeProvider } from './theme/ThemeProvider';
import type { Workspace } from './workspace/service';
import { aiBridge } from './notes/ai-bridge';
import { Describer, installDescriber } from './notes/describer';

// Before anything renders: the theme this device last showed (T28); the notebook's choice
// replaces it once its workspace has been read.
const theme = new ThemeController(browserThemeEnvironment());
theme.start();

// Tab stays inside an open modal dialog (T39).
installModalFocusTrap(document);

// Tracked controls' clicks, by their `data-event` ids (PEN-137).
installClickTracking(document);

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
const windows = storeSync(bridge);

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
    // ⌘-click on a wikilink: a tab behind this one in the main window (PEN-140), else the
    // browser's own new tab.
    openTab: (path) => {
      if (hasTabs()) openPath(path, 'background');
      else window.open(path, '_blank', 'noopener');
    },
    // ⌥-click (T45, A710).
    openWindow: (id, heading) => openNoteWindow(id, heading),
  });

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
  storage: deviceStorage(),
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
  // The tabs as they are, for the next launch (A228, A626). As the window closes, the last
  // time: a main window opened while this one still pushes keeps its own (A1577).
  if (reason === 'close') tabs?.closeWindow();
  else tabs?.flush();
  await sources.store(reason);
  // The other windows hear this window's last writes before it goes (before `saved`).
  windows.flush();
});

// A note window reads its note from the store: this window's last keystrokes go there first,
// and the other windows hear of them (A1591).
if (bridge) {
  setStoreBeforeNoteWindow(async () => {
    await sources.store('flush');
    windows.flush();
  });
}

// Send feedback (T49): its outbox sends what waits, here and when back online. Its sync facts
// are the Journal notebook's (the app's own, A827).
const rootNotes = () => sources.getState().journal?.notes ?? null;
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
// AI Descriptions (PEN-161): one window describes changed notes on its own; any answers Describe
// Now. Never the capture window.
if (!capture) {
  installDescriber(
    new Describer({
      sources: () => sources.getState().all,
      subscribeSources: sources.subscribe,
      settings: () => sources.getState().journal?.workspace.settings() ?? {},
      bridge: aiBridge(),
      locks: typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : null,
    }),
  );
}
// The main window's note tabs (PEN-140, A1496): its history, restored from the last launch.
// A note window and the capture window have none (D37).
const tabs =
  noteWindow || capture
    ? null
    : installMainTabs({
        storage: deviceStorage(),
        location: window.location.pathname + window.location.search,
      });
// The kept editors favour the notes in tabs (A1500).
if (tabs) setTabNotes(() => shownNotes(tabs.getState()));
createRoot(container).render(
  <StrictMode>
    <SourcesProvider sources={sources}>
      <FeedbackContext.Provider value={feedback}>
        <FirstRunGate capture={capture}>
          <JournalScope>
            <ThemeProvider controller={theme}>
              {capture ? <CaptureWindow /> : <App />}
            </ThemeProvider>
          </JournalScope>
        </FirstRunGate>
      </FeedbackContext.Provider>
    </SourcesProvider>
  </StrictMode>,
);
