import { openLightboxNow } from '@penmoss/editor';
import { useEffect } from 'react';
import { useCommand, useCommands } from '../commands/hooks';
import { drawingEditorOpen } from '../drawing/drawings';
import { goBack, goForward, useHistoryPlace } from '../router';

/** The mouse's back and forward buttons (`MouseEvent.button`). */
export const MOUSE_BACK = 3;
export const MOUSE_FORWARD = 4;

/**
 * Which way a mouse button steps through history, or null for any other button (T51, A943).
 * Only in the Mac app: a browser goes back and forward on these buttons itself.
 */
export function mouseStep(button: number): 'back' | 'forward' | null {
  if (button === MOUSE_BACK) return 'back';
  if (button === MOUSE_FORWARD) return 'forward';
  return null;
}

/**
 * A key on a focused tab of the strip: ⌥← and ⌥→ move it there (PEN-140), where Back and
 * Forward's keys off Apple platforms are the same, so they give way.
 */
function onTab(event: Event | undefined): boolean {
  const target = event?.target;
  return target instanceof Element && target.closest('.tab-strip [role="tab"]') !== null;
}

/**
 * Back and Forward through this window's own history (T45 for a note window; T51, A943 for the
 * main window): the notes, Today and This Week, Search, the graph, Settings' pages and Trash all
 * have their address, so the browser's history is the app's. Each window has its own. The
 * commands answer the buttons, the palette, the Mac's Go menu, ⌘[ and ⌘] and the mouse's back
 * and forward buttons. Both grey out at either end.
 */
export function useHistoryCommands(): void {
  const place = useHistoryPlace();
  useCommand(
    'window.back',
    (context) => {
      if (context.source === 'key' && onTab(context.event)) return false;
      goBack();
      return true;
    },
    () => place.back,
  );
  useCommand(
    'window.forward',
    (context) => {
      if (context.source === 'key' && onTab(context.event)) return false;
      goForward();
      return true;
    },
    () => place.forward,
  );
  const commands = useCommands();
  useEffect(() => {
    // Electron leaves these buttons to the page (on a Mac they arrive as mouse events).
    const onMouseUp = (event: MouseEvent) => {
      const step = mouseStep(event.button);
      if (step === null) return;
      event.preventDefault();
      // Not from behind the image lightbox, which is modal (T51 review, A948), nor the drawing
      // editor, whose own Back and Forward keep the drawing first (R2-18).
      if (openLightboxNow()?.open || drawingEditorOpen()) return;
      commands.run(step === 'back' ? 'window.back' : 'window.forward');
    };
    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, [commands]);
}
