/**
 * The drawing editor's dialog (PEN-28): Excalidraw (MIT, pinned in package.json) over the whole
 * window, in the app's light or dark mode. Its bar is the window's title bar while it is open
 * (R2-17, R2-18): it drags the window in the Mac app, the traffic lights before it, then Back,
 * Forward and the pin as the app's own title bar has them, the editor's title, and Cancel and
 * Done as the app's icon and text buttons. Back and Forward keep the drawing, as Done does, then
 * go. Excalidraw's menu offers Save To… (the `.excalidraw` file) and Export Image… (PNG or SVG,
 * or a copy), saved through the browser's download, which the Mac app asks where to put (R2-19);
 * nothing opens a file, and there are no libraries, no collaboration and no AI, and nothing here
 * reaches the network. The note shows the SVG Done makes, inverted in dark mode as Excalidraw
 * itself does.
 */
import { Excalidraw, MainMenu, serializeAsJSON } from '@excalidraw/excalidraw';
import { Icon } from '@penmoss/ui/icons';
import '@excalidraw/excalidraw/index.css';
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { macWindowStore, useMacWindowState } from '../desktop/mac-window';
import { historyPlace } from '../router';
import './drawing.css';
import { drawingSvg, type DrawingResult } from './scene';

/** Where the window goes once the drawing is kept: the bar's Back or Forward. */
export type DrawingStep = 'back' | 'forward';

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
  /** Done, or Back or Forward (`step`): the drawing, or null for a new one left empty. */
  readonly onDone: (result: DrawingResult | null, step?: DrawingStep) => void;
  readonly onCancel: () => void;
  readonly onError: (message: string) => void;
  /** The app's commands: the bar's pin runs `window.keepOnTop`, as the app's own pin does. */
  readonly commands?: { run(id: string): unknown };
}

export function DrawingDialog({
  initial,
  onDone,
  onCancel,
  onError,
  commands,
}: DrawingDialogProps) {
  const dark = useDark();
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const [saving, setSaving] = useState(false);
  /** How many shapes the scene has, shown to assistive technology and read by tests. */
  const [shapes, setShapes] = useState(() => initial?.elements?.length ?? 0);

  // Back and Forward as the window has them now; nothing navigates while the editor is open.
  const [place] = useState(historyPlace);
  const { keepOnTop } = useMacWindowState();
  const pinnable = macWindowStore() !== null;

  const done = useCallback(
    async (step?: DrawingStep) => {
      const excalidraw = api.current;
      if (!excalidraw || saving) return;
      setSaving(true);
      try {
        const elements = excalidraw.getSceneElements();
        // A new drawing left empty goes nowhere, as Cancel.
        if (initial === null && elements.length === 0) {
          onDone(null, step);
          return;
        }
        const appState = excalidraw.getAppState();
        const files = excalidraw.getFiles();
        const scene = serializeAsJSON(elements, appState, files, 'local');
        onDone({ scene, svg: await drawingSvg(elements, appState, files) }, step);
      } catch (error) {
        setSaving(false);
        onError(
          `The drawing couldn't be saved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [initial, onDone, onError, saving],
  );

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
              // Nothing opens a file over the drawing; Save To… and Export Image… save one (R2-19).
              loadScene: false,
              saveToActiveFile: true,
              saveAsImage: true,
              export: { saveFileToDisk: true },
              toggleTheme: false,
            },
            tools: { image: false },
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.SaveToActiveFile />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
      </div>
      {/* The bar comes after the canvas, though it shows above it: Excalidraw lays a layer over the
          whole window (its SVG trails), and in the Mac app a later region wins over an earlier one,
          so the bar's own drag region must come last to drag the window (R2-17). */}
      <div className="drawing-editor-bar" data-testid="drawing-editor-bar">
        {/* As the app's title bar starts (A943, A720): Back and Forward, then the pin. */}
        <div className="note-top-lead drawing-editor-lead">
          <nav className="history-nav" aria-label="History">
            <span className="history-pair">
              <button
                type="button"
                className="icon-btn history-half"
                data-ui="submit"
                aria-label="Back"
                data-tip="Keep the Drawing and Go Back"
                disabled={!place.back || saving}
                data-testid="drawing-editor-back"
                onClick={() => void done('back')}
              >
                <Icon name="navBack" size={16} />
              </button>
              <button
                type="button"
                className="icon-btn history-half"
                data-ui="submit"
                aria-label="Forward"
                data-tip="Keep the Drawing and Go Forward"
                disabled={!place.forward || saving}
                data-testid="drawing-editor-forward"
                onClick={() => void done('forward')}
              >
                <Icon name="navForward" size={16} />
              </button>
            </span>
          </nav>
          {commands && pinnable ? (
            <button
              type="button"
              className="icon-btn keep-on-top"
              data-command="window.keepOnTop"
              aria-label="Keep on Top"
              aria-pressed={keepOnTop}
              data-tip={
                keepOnTop ? 'Kept on top of other apps: click to stop' : 'Keep on Top of Other Apps'
              }
              data-testid="drawing-editor-pin"
              onClick={() => commands.run('window.keepOnTop')}
            >
              <Icon name="pin" size={18} />
            </button>
          ) : null}
        </div>
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
    </div>
  );
}
