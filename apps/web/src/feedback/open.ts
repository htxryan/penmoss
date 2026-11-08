/**
 * Opening Send feedback (T49): the context is read and, in the Mac app, the window captured,
 * before the form is drawn, so both describe the screen behind it (A791, A798).
 */
import type { ThemeController } from '../theme/controller';
import { desktop, type PenmossDesktop } from '../desktop/bridge';
import { macWindowStore } from '../desktop/mac-window';
import type { Notes } from '../notes/service';
import type { Workspace } from '../workspace/service';
import type { ContextFacts } from './context';
import { gatherContext, panelsOn, selectedFolderOn, sidebarOn, type GatherDeps } from './gather';
import type { FeedbackService } from './service';

/** How long the Mac's capture of the window may take before the form opens without it. */
const CAPTURE_TIMEOUT_MS = 1500;

/** The app's build, as the context and the issue's footer name it. */
export function appVersion(bridge: PenmossDesktop | null = desktop()): string {
  const build =
    (import.meta.env['VITE_PENMOSS_BUILD'] as string | undefined) ?? import.meta.env.MODE;
  return bridge?.version ? `${bridge.version} (web ${build})` : build;
}

/** What the window is, in the context's words. */
function windowKind(bridge: PenmossDesktop | null): string {
  if (bridge) return bridge.window === 'note' ? 'note window' : bridge.window;
  if (window.location.pathname.startsWith('/window/')) return 'note window (popup)';
  return 'browser tab';
}

/** How the form was opened, in the context's words (a command's run source). */
export function openedFromLabel(
  source: 'key' | 'palette' | 'button' | 'menu',
  bridge: PenmossDesktop | null = desktop(),
): string {
  switch (source) {
    case 'key':
      return 'keyboard shortcut';
    case 'palette':
      return 'command palette';
    case 'menu':
      return bridge ? 'Mac menu' : 'menu';
    default:
      return 'button or menu in the page';
  }
}

export interface OpeningOptions {
  readonly notes: Notes;
  readonly workspace: Workspace;
  readonly theme: ThemeController;
  readonly feedback: FeedbackService;
  /** The note editor's document, when one shows. */
  readonly editorDoc: GatherDeps['editorDoc'];
  readonly openedFrom: string;
  /** The open note is a git notebook's (A889), and the git notebooks' names to scrub. */
  readonly gitNote?: boolean;
  readonly gitNames?: readonly string[];
}

/** The context, read now from the live app. */
export function openingFacts(options: OpeningOptions): ContextFacts {
  const bridge = desktop();
  const mac = bridge?.macWindow ? macWindowStore(bridge) : null;
  const { notes, workspace, theme, feedback } = options;
  const shown = theme.getState();
  const sync = notes.syncState();
  return gatherContext({
    client: bridge ? 'mac' : 'web',
    version: appVersion(bridge),
    window: windowKind(bridge),
    userAgent: navigator.userAgent,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      ratio: window.devicePixelRatio || 1,
    },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    theme: { name: shown.theme.name, variant: shown.variant, mode: shown.mode },
    mac: mac ? { titleBar: mac.titleBar, keepOnTop: mac.get().keepOnTop } : null,
    pathname: window.location.pathname,
    openedFrom: options.openedFrom,
    panels: panelsOn(document),
    sidebar: sidebarOn(document),
    selectedFolderId: selectedFolderOn(document),
    online: notes.isOnline,
    sync: {
      phase: sync.phase,
      pending: sync.pending,
      detail: sync.detail,
    },
    lastSynced: feedback.sync.lastSynced,
    lastSyncError: feedback.sync.lastError,
    feedbackOutbox: feedback.outbox.entries().length,
    snapshot: workspace.getState().snapshot,
    list: notes.list(),
    links: notes.localLinks(),
    opened: (id) => notes.openCopies(id),
    openTexts: () => notes.openTexts(),
    editorDoc: options.editorDoc,
    windowsShowing: (id) => feedback.presence.windowsShowing(id),
    errors: feedback.errors.recent(),
    gitNote: options.gitNote ?? false,
    gitNames: options.gitNames ?? [],
  });
}

/** The Mac app's capture of this window as it is now, or null (a browser, a slow answer). */
export async function captureWindow(
  bridge: PenmossDesktop | null = desktop(),
): Promise<Blob | null> {
  const feedback = bridge?.feedback;
  if (!feedback) return null;
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS),
  );
  try {
    const png = await Promise.race([feedback.capture(), timeout]);
    return png && png.byteLength > 0
      ? new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' })
      : null;
  } catch {
    return null;
  }
}
