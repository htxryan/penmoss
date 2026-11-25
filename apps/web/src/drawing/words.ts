/**
 * The drawing editor's words (PEN-28; PEN-189), one source for the Mac's and Android's: its title,
 * as the slash menu names a drawing, and what it says when a drawing can't be opened or saved.
 * Only "this Mac" and "this phone" differ. No Excalidraw here: Android's note page imports it.
 */

/** The editor's title: a new drawing's, or one opened again. */
export function drawingTitle(isNew: boolean): string {
  return isNew ? 'New Excalidraw Diagram' : 'Edit Excalidraw Diagram';
}

/** A drawing whose scene file this device doesn't have yet. */
export function drawingMissing(device: 'Mac' | 'phone'): string {
  return `This drawing's file isn't on this ${device} yet`;
}

export const DRAWING_EDITOR_UNLOADED = "The drawing editor couldn't be loaded";

export const DRAWING_UNREADABLE = "This drawing's file couldn't be read";

/** A drawing that couldn't be saved, and why. */
export function drawingNotSaved(error: unknown): string {
  return `The drawing couldn't be saved: ${error instanceof Error ? error.message : String(error)}`;
}
