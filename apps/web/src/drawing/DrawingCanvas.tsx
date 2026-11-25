/**
 * Excalidraw as Penmoss draws with it (PEN-28, A1370; PEN-189): the one canvas the Mac's drawing
 * editor (DrawingDialog, under its own bar) and Android's (under the app's top bar) both show. It
 * follows the app's light or dark mode, offers only drawing (no opening a file, no image tool, no
 * theme toggle, no libraries, no collaboration and no AI), and reports how many shapes it has
 * (`onShapes`), which each editor shows to assistive technology and tests. scene.ts's
 * `takeDrawing` reads what Done keeps.
 */
import { Excalidraw, MainMenu } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import { useEffect, useState } from 'react';
import './drawing.css';

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

export interface DrawingCanvasProps {
  readonly initial: ExcalidrawInitialDataState | null;
  /** Hands over Excalidraw's API once it is ready (scene.ts's `takeDrawing` reads it). */
  readonly onApi: (api: ExcalidrawImperativeAPI) => void;
  /** How many shapes the scene has now. */
  readonly onShapes: (count: number) => void;
  /**
   * Save To… and Export Image… in Excalidraw's menu, saved through a download (the Mac app asks
   * where, A1447). Off where nothing takes a download (Android).
   */
  readonly saving: boolean;
}

export function DrawingCanvas({ initial, onApi, onShapes, saving }: DrawingCanvasProps) {
  const dark = useDark();
  return (
    <Excalidraw
      excalidrawAPI={onApi}
      initialData={initial}
      theme={dark ? 'dark' : 'light'}
      autoFocus
      aiEnabled={false}
      onChange={(elements) => onShapes(elements.filter((element) => !element.isDeleted).length)}
      UIOptions={{
        canvasActions: {
          // Nothing opens a file over the drawing; Save To… and Export Image… save one (R2-19).
          loadScene: false,
          saveToActiveFile: saving,
          saveAsImage: saving,
          export: saving ? { saveFileToDisk: true } : false,
          toggleTheme: false,
        },
        tools: { image: false },
      }}
    >
      <MainMenu>
        {saving ? (
          <>
            <MainMenu.DefaultItems.SaveToActiveFile />
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.Separator />
          </>
        ) : null}
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  );
}
