/**
 * Drawings (PEN-28): the editor's `DrawingServices` for the Mac app's page. Opening a drawing
 * loads the drawing editor (Excalidraw, ./editor.tsx) the first time, so it adds nothing to
 * the app's start-up; Done stores the scene as `attachments/<sha256>.excalidraw` and its picture
 * as `attachments/<sha256>.svg`, content-addressed like any attachment, and the note points at
 * the new pair.
 *
 * Excalidraw's fonts are files of the app's own bundle (vite.config.ts copies them to
 * `excalidraw/fonts/`): `EXCALIDRAW_ASSET_PATH` points it there, and its font faces keep only
 * those files (font-faces.ts), never its CDN.
 */
import type { DrawingFiles, DrawingServices } from '@penmoss/editor';
import { keepFontFacesLocal } from './font-faces';

/** Where the drawing's files are kept: this device's attachment store (A1032). */
export interface DrawingStore {
  bytes(src: string): Promise<Uint8Array<ArrayBuffer> | null>;
  addFile(bytes: Uint8Array<ArrayBuffer>, name: string): Promise<{ readonly path: string }>;
}

/** Where the bundle keeps Excalidraw's fonts (vite.config.ts, `excalidrawAssets`). */
export const EXCALIDRAW_ASSETS = '/excalidraw/';

type DrawingEditorModule = typeof import('./editor');

let loading: Promise<DrawingEditorModule> | null = null;

/** The drawing editor's chunk, loaded once; a failed load (offline before cached) may be retried. */
export function loadDrawingEditor(): Promise<DrawingEditorModule> {
  if (!loading) {
    const target = window as Window & {
      EXCALIDRAW_ASSET_PATH?: string;
      EXCALIDRAW_EXPORT_SOURCE?: string;
    };
    target.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSETS;
    // The `source` a scene file names: Penmoss, not the app's own origin.
    target.EXCALIDRAW_EXPORT_SOURCE = 'https://penmoss.app';
    keepFontFacesLocal();
    loading = import('./editor');
    loading.catch(() => (loading = null));
  }
  return loading;
}

/** Whether a drawing editor is open in this window (one at a time). */
let open = false;

export interface DrawingServicesOptions {
  /** Shows a message about a drawing that couldn't be opened or saved. */
  readonly onError: (message: string) => void;
  /**
   * Holds the app's shortcuts while the drawing editor is open (Excalidraw's own keys, such as
   * Undo, are the drawing's); returns the call that gives them back.
   */
  readonly suspendShortcuts?: () => () => void;
}

export function drawingServices(
  store: DrawingStore,
  { onError, suspendShortcuts }: DrawingServicesOptions,
): DrawingServices {
  return {
    async edit(scene): Promise<DrawingFiles | null> {
      if (open) return null;
      open = true;
      try {
        let text: string | null = null;
        if (scene) {
          const bytes = await store.bytes(scene);
          if (!bytes) {
            onError("This drawing's file isn't on this Mac yet");
            return null;
          }
          text = new TextDecoder().decode(bytes);
        }
        let editor: DrawingEditorModule;
        try {
          editor = await loadDrawingEditor();
        } catch {
          onError("The drawing editor couldn't be loaded");
          return null;
        }
        const resume = suspendShortcuts?.();
        let drawn;
        try {
          drawn = await editor.openDrawingEditor({ scene: text, onError });
        } finally {
          resume?.();
        }
        if (!drawn) return null;
        const encoder = new TextEncoder();
        const saved = await store.addFile(encoder.encode(drawn.scene), 'drawing.excalidraw');
        const svg = await store.addFile(encoder.encode(drawn.svg), 'drawing.svg');
        return { scene: saved.path, svg: svg.path };
      } catch (error) {
        onError(
          `The drawing couldn't be saved: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      } finally {
        open = false;
      }
    },
  };
}
