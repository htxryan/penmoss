/**
 * The drawing editor (PEN-28), its own chunk: loaded by drawings.ts the first time a drawing
 * opens, so Excalidraw adds nothing to the app's start-up. Done hands back the scene as
 * Excalidraw's JSON (what a `.excalidraw` file holds) and its picture as an SVG (scene.ts).
 */
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { createRoot } from 'react-dom/client';
import { DrawingDialog, type DrawingStep } from './DrawingDialog';
import { parseScene, type DrawingResult } from './scene';
import { DRAWING_UNREADABLE } from './words';

export type { DrawingStep } from './DrawingDialog';
export type { DrawingResult } from './scene';

/** How the editor closed: Done's files (null on Cancel), and Back or Forward if one closed it. */
export interface DrawingOutcome {
  readonly drawn: DrawingResult | null;
  readonly step: DrawingStep | null;
}

export interface DrawingEditorOptions {
  /** The scene to open (a `.excalidraw` file's text), or null for a new drawing. */
  readonly scene: string | null;
  readonly onError: (message: string) => void;
  /** The app's commands, for the bar's pin. */
  readonly commands?: { run(id: string): unknown };
}

/** Opens the drawing editor over the page; resolves with Done's files, or none on Cancel. */
export function openDrawingEditor(options: DrawingEditorOptions): Promise<DrawingOutcome> {
  let initial: ExcalidrawInitialDataState | null = null;
  if (options.scene !== null) {
    try {
      initial = parseScene(options.scene);
    } catch {
      options.onError(DRAWING_UNREADABLE);
      return Promise.resolve({ drawn: null, step: null });
    }
  }
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'drawing-editor-host';
    document.body.append(host);
    const root = createRoot(host);
    const close = (drawn: DrawingResult | null, step?: DrawingStep) => {
      root.unmount();
      host.remove();
      resolve({ drawn, step: step ?? null });
    };
    root.render(
      <DrawingDialog
        initial={initial}
        onDone={close}
        onCancel={() => close(null)}
        onError={options.onError}
        {...(options.commands ? { commands: options.commands } : {})}
      />,
    );
  });
}
