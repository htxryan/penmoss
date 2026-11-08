/**
 * Where a floating comment goes (T52 item 5): below the passage it is on, or above it when there
 * is more room there, and moved along so it stays inside the window. Viewport pixels: the
 * popover is `position: fixed`, placed again as the note scrolls and the window resizes.
 */

export interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface PopoverPlace {
  readonly top: number;
  readonly left: number;
  /** Which side of the passage it is on. */
  readonly side: 'below' | 'above';
}

/** Space between the passage and the popover, and between the popover and the window's edge. */
export const POPOVER_GAP = 8;

export function placePopover(
  anchor: Box,
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): PopoverPlace {
  const below = viewport.height - anchor.bottom - POPOVER_GAP;
  const above = anchor.top - POPOVER_GAP;
  // Below when it fits there, or when there is no more room above.
  const side = size.height + POPOVER_GAP <= below || below >= above ? 'below' : 'above';
  const wanted =
    side === 'below' ? anchor.bottom + POPOVER_GAP : anchor.top - POPOVER_GAP - size.height;
  const top = Math.max(POPOVER_GAP, Math.min(wanted, viewport.height - size.height - POPOVER_GAP));
  const left = Math.max(
    POPOVER_GAP,
    Math.min(anchor.left, viewport.width - size.width - POPOVER_GAP),
  );
  return { top, left, side };
}
