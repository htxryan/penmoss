/**
 * The drawing editor (PEN-28), its own chunk: loaded by drawings.ts the first time a drawing
 * opens, so Excalidraw adds nothing to the app's start-up. Done hands back the scene as
 * Excalidraw's JSON (what a `.excalidraw` file holds) and its picture as an SVG (scene.ts).
 */
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { createRoot } from 'react-dom/client';
import { DrawingDialog } from './DrawingDialog';
import { parseScene, type DrawingResult } from './scene';

export type { DrawingResult } from './scene';

export interface DrawingEditorOptions {
  /** The scene to open (a `.excalidraw` file's text), or null for a new drawing. */
  readonly scene: string | null;
  readonly onError: (message: string) => void;
}

/** Opens the drawing editor over the page; resolves with Done's files, or null on Cancel. */
export function openDrawingEditor(options: DrawingEditorOptions): Promise<DrawingResult | null> {
  let initial: ExcalidrawInitialDataState | null = null;
  if (options.scene !== null) {
    try {
      initial = parseScene(options.scene);
    } catch {
      options.onError("This drawing's file couldn't be read");
      return Promise.resolve(null);
    }
  }
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'drawing-editor-host';
    document.body.append(host);
    const root = createRoot(host);
    const close = (result: DrawingResult | null) => {
      root.unmount();
      host.remove();
      resolve(result);
    };
    root.render(
      <DrawingDialog
        initial={initial}
        onDone={close}
        onCancel={() => close(null)}
        onError={options.onError}
      />,
    );
  });
}
