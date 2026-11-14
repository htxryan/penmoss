/**
 * The drawing editor's dialog (PEN-28): Excalidraw (MIT, pinned in package.json) over the whole
 * window, with Cancel and Done as the app's icon and text buttons, in the app's light or dark
 * mode. Only drawing tools are offered: no files to open or save, no libraries, no collaboration
 * and no AI, and nothing here reaches the network. The note shows the SVG Done makes, inverted in
 * dark mode as Excalidraw itself does.
 */
import { Excalidraw, MainMenu, serializeAsJSON } from '@excalidraw/excalidraw';
import { Icon } from '@penmoss/ui/icons';
import '@excalidraw/excalidraw/index.css';
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import './drawing.css';
import { drawingSvg, type DrawingResult } from './scene';

/** The app's mode as shown now (`data-mode` on `<html>`, set by the theme, T28). */
function darkNow(): boolean {
  return document.documentElement.getAttribute('data-mode') === 'dark';
}

/** Follows the app's light or dark mode while the editor is open. */
function useDark(): boolean {
  const [dark, setDark] = useState(darkNow);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(darkNow()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-mode'],
    });
    return () => observer.disconnect();
  }, []);
  return dark;
}

export interface DrawingDialogProps {
  readonly initial: ExcalidrawInitialDataState | null;
  readonly onDone: (result: DrawingResult | null) => void;
  readonly onCancel: () => void;
  readonly onError: (message: string) => void;
}

export function DrawingDialog({ initial, onDone, onCancel, onError }: DrawingDialogProps) {
  const dark = useDark();
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const [saving, setSaving] = useState(false);
  /** How many shapes the scene has, shown to assistive technology and read by tests. */
  const [shapes, setShapes] = useState(() => initial?.elements?.length ?? 0);

  const done = useCallback(async () => {
    const excalidraw = api.current;
    if (!excalidraw || saving) return;
    setSaving(true);
    try {
      const elements = excalidraw.getSceneElements();
      // A new drawing left empty goes nowhere, as Cancel.
      if (initial === null && elements.length === 0) {
        onDone(null);
        return;
      }
      const appState = excalidraw.getAppState();
      const files = excalidraw.getFiles();
      const scene = serializeAsJSON(elements, appState, files, 'local');
      onDone({ scene, svg: await drawingSvg(elements, appState, files) });
    } catch (error) {
      setSaving(false);
      onError(
        `The drawing couldn't be saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [initial, onDone, onError, saving]);

  /** A drawing is named as the slash menu names it. */
  const title = initial ? 'Edit Excalidraw Diagram' : 'New Excalidraw Diagram';

  return (
    <div
      className="drawing-editor"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="drawing-editor"
      data-shapes={shapes}
    >
      <div className="drawing-editor-bar">
        <span className="drawing-editor-title">{title}</span>
        <span className="drawing-editor-actions">
          <button
            type="button"
            className="btn drawing-editor-cancel"
            data-ui="dismiss"
            onClick={onCancel}
          >
            <Icon name="close" size={14} />
            Cancel
          </button>
          <button
            type="button"
            className="btn primary drawing-editor-done"
            data-ui="submit"
            disabled={saving}
            onClick={() => void done()}
          >
            <Icon name="check" size={14} />
            Done
          </button>
        </span>
      </div>
      <div className="drawing-editor-canvas">
        <Excalidraw
          excalidrawAPI={(instance) => (api.current = instance)}
          initialData={initial}
          theme={dark ? 'dark' : 'light'}
          autoFocus
          aiEnabled={false}
          onChange={(elements) => {
            const count = elements.filter((element) => !element.isDeleted).length;
            setShapes((current) => (current === count ? current : count));
          }}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              saveAsImage: false,
              export: false,
              toggleTheme: false,
            },
            tools: { image: false },
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      </div>
    </div>
  );
}
