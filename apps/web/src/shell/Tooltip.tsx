import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { placeTip, TIP_DELAY_MS, type Box } from './tooltip-place';

interface Shown {
  readonly text: string;
  readonly anchor: Box;
}

/**
 * One tooltip for the whole app (T36, A189). A control with `data-tip` shows
 * it after the mouse rests on it, or at once when it gets keyboard focus; it
 * goes on pointer down, Escape, scroll and blur. The control's name is its
 * `aria-label` (and shortcut, `aria-keyshortcuts`), so the tooltip is hidden
 * from assistive technology. It is drawn in a layer of its own, so a
 * scrolling sidebar or a sticky header never clips it, and unlike `title` it
 * shows for keyboard focus and in the app's own style. A list row's tip
 * (`data-tip-on="hover"`) adds facts, not the row's name, and shows on hover
 * only.
 */
export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<ReturnType<typeof placeTip> | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;
    const hide = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      current = null;
      setShown(null);
    };
    const show = (element: HTMLElement) => {
      const text = element.dataset['tip'];
      if (!text || element.getAttribute('aria-expanded') === 'true') return;
      const rect = element.getBoundingClientRect();
      setShown({
        text,
        anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      });
    };
    const tipOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const element = tipOf(event.target);
      if (element === current) return;
      hide();
      if (!element) return;
      current = element;
      timer = setTimeout(() => show(element), TIP_DELAY_MS);
    };
    const onFocusIn = (event: FocusEvent) => {
      const element = tipOf(event.target);
      if (element !== event.target) return;
      hide();
      // A row's extra facts (A573) show on hover only: arrowing through a list would show one
      // per row.
      if (element && element.matches(':focus-visible') && element.dataset['tipOn'] !== 'hover') {
        current = element;
        show(element);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      document.removeEventListener('pointerover', onPointerOver);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!shown || !tip) {
      setPlace(null);
      return;
    }
    setPlace(
      placeTip(
        shown.anchor,
        { width: tip.offsetWidth, height: tip.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [shown]);

  if (!shown) return null;
  return (
    <div
      ref={tipRef}
      className="tooltip"
      aria-hidden="true"
      data-testid="tooltip"
      data-side={place?.side}
      style={
        place
          ? { left: place.left, top: place.top }
          : // Measured at the window's corner: at the control's own place, one near the
            // right edge squeezed the tip into wrapping before it was placed (T51).
            { left: 0, top: 0, visibility: 'hidden' }
      }
    >
      {shown.text}
    </div>
  );
}
