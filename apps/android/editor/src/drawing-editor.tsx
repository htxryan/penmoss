/**
 * Android's drawing editor (PEN-189), its own chunk: loaded by drawings.ts the first time a drawing
 * opens, so Excalidraw adds nothing to the note's start-up. Excalidraw fills the note's WebView,
 * the canvas the Mac's drawing editor shows (`DrawingCanvas`), and the app's own top bar sits above
 * it with the title, Cancel and Done (the note screen's drawing bar). Excalidraw's Save To… and
 * Export Image… are left out: a download has nowhere to go here.
 */
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import { createRoot } from 'react-dom/client';
import { DrawingCanvas } from '../../../web/src/drawing/DrawingCanvas';
import { parseScene, takeDrawing, type DrawingResult } from '../../../web/src/drawing/scene';

export type { DrawingResult } from '../../../web/src/drawing/scene';

/** The drawing editor over the note, until `close`. */
export interface OpenDrawing {
  /** What Done keeps; null for a new drawing left empty. Rejects when it can't be made. */
  take(): Promise<DrawingResult | null>;
  close(): void;
}

/**
 * Opens the drawing editor on a `.excalidraw` file's text, or an empty canvas for a new drawing.
 * Throws when the text is not an Excalidraw scene.
 */
export function openDrawingEditor(scene: string | null, title: string): OpenDrawing {
  const initial: ExcalidrawInitialDataState | null = scene === null ? null : parseScene(scene);
  const host = document.createElement('div');
  host.className = 'drawing-editor android-drawing-editor';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-label', title);
  host.dataset['testid'] = 'drawing-editor';
  host.dataset['shapes'] = String(initial?.elements?.length ?? 0);
  const canvas = document.createElement('div');
  canvas.className = 'drawing-editor-canvas';
  host.append(canvas);
  document.body.append(host);
  let api: ExcalidrawImperativeAPI | null = null;
  const root = createRoot(canvas);
  root.render(
    <DrawingCanvas
      initial={initial}
      onApi={(instance) => (api = instance)}
      onShapes={(count) => (host.dataset['shapes'] = String(count))}
      saving={false}
    />,
  );
  return {
    take: async () => {
      if (!api) throw new Error('the drawing editor is still opening');
      return takeDrawing(api, initial === null);
    },
    close: () => {
      root.unmount();
      host.remove();
    },
  };
}
