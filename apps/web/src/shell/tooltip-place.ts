/** How long the pointer rests on a control before its tooltip shows. */
export const TIP_DELAY_MS = 400;
/** The gap between a control and its tooltip, and the least space kept to the window's edge. */
const GAP = 6;
const EDGE = 8;

export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a tooltip goes (T36, A189): centred below its control, moved inside
 * the window when it would cross an edge, and above the control when there
 * is no room below.
 */
export function placeTip(
  anchor: Box,
  tip: { readonly width: number; readonly height: number },
  view: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number; readonly side: 'below' | 'above' } {
  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = Math.max(EDGE, Math.min(centred, view.width - EDGE - tip.width));
  const below = anchor.top + anchor.height + GAP;
  if (below + tip.height <= view.height - EDGE) return { left, top: below, side: 'below' };
  return { left, top: Math.max(EDGE, anchor.top - GAP - tip.height), side: 'above' };
}
