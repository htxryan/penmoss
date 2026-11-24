/**
 * What the app's web contents may do (T29, A224). Pages run sandboxed with
 * context isolation and no Node; they may only be the bundled app
 * (`app://penmoss/`). A link to anywhere else opens in the app the Mac
 * gives it (http, https, mailto and tel only, A1684), never in the app; new
 * windows, webviews and permission prompts are refused, except writing to the
 * clipboard. A
 * download asks where to save it (R2-19).
 */
import { extname, join } from 'node:path';
import { PAGE_ORIGIN } from './config';

export const isAppUrl = (url: string): boolean => url.startsWith(`${PAGE_ORIGIN}/`);

/** Whether a link may be handed to the default browser. */
export function isExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return ['https:', 'http:', 'mailto:', 'tel:'].includes(protocol);
  } catch {
    return false;
  }
}

/**
 * Where a link a page opens in a new window goes (`target="_blank"`, `window.open`), but a note
 * window's (`noteWindowPath`): an app page to the main window, a web or mail link to the default
 * browser (Settings → a notebook → Open on GitHub, A1565), anything else nowhere.
 */
export function openedLink(
  url: string,
): { readonly kind: 'app'; readonly path: string } | { readonly kind: 'browser' } | null {
  const path = appPath(url);
  if (path) return { kind: 'app', path };
  return isExternalUrl(url) ? { kind: 'browser' } : null;
}

/** The in-app path of an app URL (`/notes/…?heading=…`), or null. */
export function appPath(url: string): string | null {
  if (!isAppUrl(url)) return null;
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

/**
 * Permissions a page may have: writing to the clipboard (T15's copy commands), keeping the
 * app's stores under low storage (`navigator.storage.persist()`, A886): refused, Chromium may
 * clear them, git notebooks' changes not pushed yet with them; and the image lightbox's Full
 * Screen (`requestFullscreen()`, A948): refused, Electron never settles the request, so the
 * button did nothing (T51's manual pass).
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'persistent-storage',
]);

/** What a download's save dialog shows (Electron's `SaveDialogOptions`, the parts used here). */
interface DownloadDialog {
  readonly title: string;
  readonly defaultPath: string;
  readonly filters?: { name: string; extensions: string[] }[];
}

/** The kinds of file a page saves (the drawing editor's Save To… and Export Image…). */
const DOWNLOAD_KINDS: Readonly<Record<string, string>> = {
  excalidraw: 'Excalidraw Scene',
  png: 'PNG Image',
  svg: 'SVG Image',
};

/**
 * A page's download (R2-19: the drawing editor's Save To… and Export Image…, which save through
 * the browser's download in the Mac app) always asks where to save it, in the Downloads folder by
 * default, never saving there unasked; its kind of file is the dialog's filter.
 */
export function downloadDialog(fileName: string, downloads: string): DownloadDialog {
  const name = fileName.trim() || 'Untitled';
  const extension = extname(name).slice(1).toLowerCase();
  const kind = DOWNLOAD_KINDS[extension];
  return {
    title: 'Save',
    defaultPath: join(downloads, name),
    ...(kind ? { filters: [{ name: kind, extensions: [extension] }] } : {}),
  };
}

/** The parts of an IPC event that say where it came from. */
interface IpcSource {
  readonly senderFrame: { readonly url: string } | null;
  readonly sender: { readonly mainFrame: unknown };
}

/**
 * Whether an IPC message comes from the main frame of an app page (A224).
 * Subframes never get the preload, and anything not on `app://penmoss/` is
 * refused all the same.
 */
export function isAppFrame(event: IpcSource): boolean {
  const frame = event.senderFrame;
  return Boolean(frame && frame === event.sender.mainFrame && isAppUrl(frame.url));
}

/**
 * Whether an IPC message comes from the app page of a main or note window (A503, A541, A712):
 * the pages that manage git notebooks, set the menus and the theme, and change the capture hotkey. The
 * capture window, or anything else, gets nothing. `kindOf` is the window registry's.
 */
export function isAppWindowFrame(
  event: IpcSource,
  kindOf: (contents: unknown) => 'main' | 'note' | null,
): boolean {
  return kindOf(event.sender) !== null && isAppFrame(event);
}

/**
 * When a page may write the clipboard (T29 review): just after a key press or
 * click in it (the preload reads `navigator.userActivation`, which a page
 * script cannot fake), or just after a menu command, whose click the page
 * never sees. As the web's Clipboard API asks, a script alone cannot.
 */
export class ClipboardGate {
  /** How long after a menu command its copy may land (the page renders it first). */
  static readonly MENU_MS = 5000;
  private menuAt = Number.NEGATIVE_INFINITY;

  menuCommand(now: number): void {
    this.menuAt = now;
  }

  allows(request: { readonly gesture: boolean; readonly now: number }): boolean {
    return request.gesture || request.now - this.menuAt <= ClipboardGate.MENU_MS;
  }
}
