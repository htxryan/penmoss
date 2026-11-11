import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { toasts, useSlotElement } from './toasts';

/**
 * Renders a component's own toast (one with state and controls: Trash's Undo, Feedback's link)
 * into the window's stack (PEN-63), in its turn: it takes a place when `children` is shown
 * and gives it up when it is not. Past the stack's cap it waits until there is room.
 */
export function ToastSlot({ children }: { readonly children: ReactNode }) {
  const showing = children !== null && children !== undefined && children !== false;
  const [id] = useState(() => toasts.reserve());
  useEffect(() => {
    if (!showing) return;
    toasts.hold(id);
    return () => toasts.dismiss(id);
  }, [showing, id]);
  const element = useSlotElement(id);
  return showing && element ? createPortal(children, element) : null;
}
