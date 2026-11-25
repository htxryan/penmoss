/**
 * Drawings on Android (PEN-189; PEN-28, A1369): the editor's `DrawingServices` for the note's
 * page, as apps/web/src/drawing/drawings.ts is the Mac's. Opening a drawing loads the drawing
 * editor (Excalidraw, ./drawing-editor.tsx) the first time, so it adds nothing to opening a note,
 * and tells the app, whose note screen shows its drawing bar (the title, Cancel and Done) over it.
 * The app's Done or Cancel comes back as `finish`. Done stores the scene as
 * `attachments/<sha256>.excalidraw` and its picture as `attachments/<sha256>.svg` through the app,
 * as any file, and the note points at the new pair.
 *
 * Excalidraw's fonts are files of the APK beside the page (vite.config.ts copies them to
 * `excalidraw/fonts/`), and its font faces keep only those, never its CDN (font-faces.ts).
 */
import type { DrawingFiles, DrawingServices } from '@penmoss/editor';
import { keepFontFacesLocal } from '../../../web/src/drawing/font-faces';
import {
  DRAWING_EDITOR_UNLOADED,
  DRAWING_UNREADABLE,
  drawingMissing,
  drawingNotSaved,
  drawingTitle,
} from '../../../web/src/drawing/words';
import type { OpenDrawing } from './drawing-editor';
import type { DrawingShown } from './protocol';

/** The app's end of a drawing: its files, and its drawing bar. */
export interface DrawingHooks {
  /** A `.excalidraw` file's text, from the phone (null when it isn't there). */
  scene(path: string): Promise<string | null>;
  /** Stores a file of the drawing; resolves with its attachment path, rejects when it can't. */
  store(bytes: Uint8Array<ArrayBuffer>, name: string): Promise<string>;
  shown(state: DrawingShown): void;
  notice(message: string): void;
}

/** The app's Done or Cancel on its drawing bar. */
type DrawingFinish = 'done' | 'cancel';

type DrawingEditorModule = typeof import('./drawing-editor');

let loading: Promise<DrawingEditorModule> | null = null;

/** The drawing editor's chunk, loaded once; a failed load may be retried. */
function loadDrawingEditor(): Promise<DrawingEditorModule> {
  if (!loading) {
    const target = window as Window & {
      EXCALIDRAW_ASSET_PATH?: string;
      EXCALIDRAW_EXPORT_SOURCE?: string;
    };
    // Beside the page in the APK: `…/assets/editor/excalidraw/`.
    target.EXCALIDRAW_ASSET_PATH = new URL('excalidraw/', document.baseURI).href;
    // The `source` a scene file names: Penmoss, as the Mac's do.
    target.EXCALIDRAW_EXPORT_SOURCE = 'https://penmoss.app';
    keepFontFacesLocal();
    loading = import('./drawing-editor');
    loading.catch(() => (loading = null));
  }
  return loading;
}

/** The drawing services, and the app's Done or Cancel for the drawing open now. */
export interface AndroidDrawings {
  readonly services: DrawingServices;
  /** The app's drawing bar: Done keeps the drawing, Cancel leaves the note as it was. */
  finish(action: DrawingFinish): void;
  /** Whether the drawing editor is open now. */
  open(): boolean;
}

export function androidDrawings(hooks: DrawingHooks): AndroidDrawings {
  /** How the bar's next Done or Cancel reaches the drawing open now (while it waits for one). */
  let current: { readonly finished: (action: DrawingFinish) => void } | null = null;
  /** A Cancel that came while Done was being saved (the note closing): taken once it fails. */
  let cancelled = false;
  let busy = false;
  let shown = false;

  /** Waits for the bar until Done keeps something (or a new drawing left empty), or Cancel. */
  async function finished(editor: OpenDrawing, title: string): Promise<DrawingFiles | null> {
    for (;;) {
      if (cancelled) return null;
      const action = await new Promise<DrawingFinish>((resolve) => {
        current = { finished: resolve };
      });
      // A second tap while this one is saved does nothing (the bar's buttons wait too).
      current = null;
      if (action === 'cancel') return null;
      hooks.shown({ title, saving: true });
      try {
        const drawn = await editor.take();
        if (!drawn) return null;
        const encoder = new TextEncoder();
        const scene = await hooks.store(encoder.encode(drawn.scene), 'drawing.excalidraw');
        const svg = await hooks.store(encoder.encode(drawn.svg), 'drawing.svg');
        return { scene, svg };
      } catch (error) {
        // The editor stays open, as the Mac's does, so nothing drawn is lost.
        hooks.notice(drawingNotSaved(error));
        hooks.shown({ title, saving: false });
      }
    }
  }

  const services: DrawingServices = {
    async edit(scene): Promise<DrawingFiles | null> {
      if (busy) return null;
      busy = true;
      cancelled = false;
      let editor: OpenDrawing | null = null;
      let files: DrawingFiles | null = null;
      try {
        let text: string | null = null;
        if (scene) {
          text = await hooks.scene(scene);
          if (text === null) {
            hooks.notice(drawingMissing('phone'));
            return null;
          }
        }
        let module: DrawingEditorModule;
        try {
          module = await loadDrawingEditor();
        } catch {
          hooks.notice(DRAWING_EDITOR_UNLOADED);
          return null;
        }
        // A drawing is named as the slash menu names it.
        const title = drawingTitle(!scene);
        try {
          editor = module.openDrawingEditor(text, title);
        } catch {
          hooks.notice(DRAWING_UNREADABLE);
          return null;
        }
        shown = true;
        hooks.shown({ title, saving: false });
        files = await finished(editor, title);
        return files;
      } finally {
        current = null;
        if (editor) {
          editor.close();
          shown = false;
          hooks.shown({ title: null, kept: files !== null });
        }
        busy = false;
      }
    },
  };

  return {
    services,
    finish(action) {
      if (current) current.finished(action);
      else if (shown && action === 'cancel') cancelled = true;
    },
    open: () => shown,
  };
}
