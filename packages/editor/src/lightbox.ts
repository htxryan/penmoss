/**
 * The image lightbox (T51 item 20, A948): one picture over the page, fitted
 * to the window, to zoom (the buttons, the wheel, a pinch, a double click)
 * and pan (a drag); Reset fits it again, Full Screen uses the platform's full
 * screen where it has one, the arrow keys step through the note's pictures
 * and Escape leaves full screen, then closes. Framework-free DOM, so the web,
 * the Mac app and Android's editor page share it; its look is the web's CSS
 * (`.pm-lightbox` in apps/web/src/styles.css).
 */

export interface LightboxImage {
  /** A URL the `<img>` can show (the node view's resolved one). */
  readonly src: string;
  readonly alt: string;
  /**
   * The note's own `<img>` it came from, when there is one: stepping skips a picture whose
   * `<img>` left the note or no longer shows (its blob URL may be revoked by then).
   */
  readonly source?: HTMLImageElement;
}

export interface LightboxOptions {
  /** The pictures to step through, in the note's order. */
  readonly images: readonly LightboxImage[];
  /** The one to show first. */
  readonly index: number;
  /** Where to open it (the editor's document). */
  readonly doc?: Document;
  /** After it closed (focus is already back where it was). */
  readonly onClose?: () => void;
}

export interface Lightbox {
  readonly element: HTMLElement;
  /** The picture shown, an index into `images`. */
  readonly index: number;
  /** The zoom, as a multiple of the fitted size (1: fitted). */
  readonly zoom: number;
  /** The pan, in CSS pixels from the centre. */
  readonly offset: { readonly x: number; readonly y: number };
  readonly open: boolean;
  zoomBy(factor: number, at?: { readonly x: number; readonly y: number }): void;
  reset(): void;
  step(delta: number): void;
  close(): void;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** Each button press or key multiplies or divides the zoom by this. */
export const ZOOM_STEP = 1.5;
/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP = 24;

const SVG = 'http://www.w3.org/2000/svg';

/** A line icon drawn as the app's are (`packages/ui` Icon): decorative, its button is named. */
function icon(doc: Document, path: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const shape = doc.createElementNS(SVG, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

const ICONS = {
  zoomIn: 'M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM15 15l5 5M10.5 8v5M8 10.5h5',
  zoomOut: 'M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM15 15l5 5M8 10.5h5',
  reset: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
  fullScreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  exitFullScreen: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  close: 'M6 6l12 12M18 6 6 18',
  prev: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
} as const;

const clamp = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** The open lightbox, if any: opening another closes it. */
let current: Lightbox | null = null;

/**
 * What the host does while a lightbox is open (T51 review, A948): the web stops its keyboard
 * shortcuts, so ⌘K, ⌘[ and the rest do not act behind a modal picture. `onOpen`'s return, if
 * any, runs when that lightbox closes.
 */
export interface LightboxHooks {
  readonly onOpen?: (lightbox: Lightbox) => (() => void) | void;
}

let hooks: LightboxHooks = {};

/** Sets the host's hooks; returns their removal (which keeps hooks set since). */
export function setLightboxHooks(next: LightboxHooks): () => void {
  hooks = next;
  return () => {
    if (hooks === next) hooks = {};
  };
}

/**
 * Whether a picture can still be shown: its note `<img>`, if it has one, is still in the note
 * with a source (a picture removed from the note has had its object URL released). One not
 * loaded yet (a lazy picture further down) is fine: the lightbox loads it itself.
 */
function usable(image: LightboxImage): boolean {
  const source = image.source;
  if (!source) return true;
  return source.isConnected && Boolean(source.getAttribute('src'));
}

/** The open lightbox (for tests and the hosts), or null. */
export function openLightboxNow(): Lightbox | null {
  return current;
}

/**
 * Calls `handler` on a double click, and on a touch screen on a double tap
 * (browsers do not all send `dblclick` for one). Returns the listeners' removal.
 */
export function onDoubleActivate(
  element: HTMLElement,
  handler: (event: MouseEvent | PointerEvent) => void,
): () => void {
  let last: { at: number; x: number; y: number } | null = null;
  /** A double tap was handled: the browser's own `dblclick` after it is the same gesture. */
  let tapped = 0;
  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    const now = event.timeStamp || Date.now();
    if (
      last &&
      now - last.at < DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) < DOUBLE_TAP_SLOP
    ) {
      last = null;
      tapped = now;
      handler(event);
      return;
    }
    last = { at: now, x: event.clientX, y: event.clientY };
  };
  const onDblClick = (event: MouseEvent) => {
    if (tapped && (event.timeStamp || Date.now()) - tapped < 600) return;
    handler(event);
  };
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('dblclick', onDblClick);
  return () => {
    element.removeEventListener('pointerup', onPointerUp);
    element.removeEventListener('dblclick', onDblClick);
  };
}

/** Opens the lightbox on `images[index]`, over the whole page. */
export function openLightbox(options: LightboxOptions): Lightbox {
  current?.close();
  const doc = options.doc ?? document;
  const images = options.images.length > 0 ? options.images : [{ src: '', alt: '' }];
  const opener = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  let index = Math.min(Math.max(0, options.index), images.length - 1);
  let zoom = 1;
  let x = 0;
  let y = 0;
  let open = true;
  /** The host's undo of what it did while this one is open (`LightboxHooks.onOpen`). */
  let afterClose: (() => void) | undefined;

  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
    const element = doc.createElement(tag);
    element.className = className;
    return element;
  };
  const button = (label: string, path: string, className: string, act: () => void) => {
    const element = make('button', `pm-lightbox-btn ${className}`);
    element.type = 'button';
    element.setAttribute('aria-label', label);
    element.dataset['tip'] = label;
    element.append(icon(doc, path));
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      act();
    });
    return element;
  };

  const root = make('div', 'pm-lightbox');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.tabIndex = -1;
  root.dataset['testid'] = 'lightbox';
  const caption = make('p', 'pm-lightbox-caption');
  caption.id = `pm-lightbox-caption-${Math.random().toString(36).slice(2, 10)}`;

  const bar = make('div', 'pm-lightbox-bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Image');
  const count = make('span', 'pm-lightbox-count');
  count.setAttribute('aria-live', 'polite');
  const zoomOut = button('Zoom Out', ICONS.zoomOut, 'pm-lightbox-zoom-out', () =>
    zoomBy(1 / ZOOM_STEP),
  );
  const level = make('span', 'pm-lightbox-level');
  level.dataset['testid'] = 'lightbox-zoom';
  const zoomIn = button('Zoom In', ICONS.zoomIn, 'pm-lightbox-zoom-in', () => zoomBy(ZOOM_STEP));
  const resetButton = button('Reset', ICONS.reset, 'pm-lightbox-reset', () => reset());
  const fullScreen = button('Full Screen', ICONS.fullScreen, 'pm-lightbox-full', () => {
    void toggleFullScreen();
  });
  // Only where the platform has a full screen to give (not an iPhone's Safari, not every WebView).
  const canFullScreen =
    doc.fullscreenEnabled === true && typeof root.requestFullscreen === 'function';
  fullScreen.hidden = !canFullScreen;
  const closeButton = button('Close', ICONS.close, 'pm-lightbox-close', () => close());
  bar.append(count, zoomOut, level, zoomIn, resetButton, fullScreen, closeButton);

  const stage = make('div', 'pm-lightbox-stage');
  const img = make('img', 'pm-lightbox-img');
  img.draggable = false;
  stage.append(img);
  const prev = button('Previous Image', ICONS.prev, 'pm-lightbox-prev', () => step(-1));
  const next = button('Next Image', ICONS.next, 'pm-lightbox-next', () => step(1));
  const several = images.length > 1;
  prev.hidden = !several;
  next.hidden = !several;
  count.hidden = !several;
  root.append(bar, stage, prev, next, caption);

  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    root.dataset['zoomed'] = zoom > 1 ? 'true' : 'false';
    level.textContent = `${Math.round(zoom * 100)}%`;
    zoomOut.disabled = zoom <= MIN_ZOOM;
    zoomIn.disabled = zoom >= MAX_ZOOM;
    resetButton.disabled = zoom === 1 && x === 0 && y === 0;
    // A pressed button that this disables (Reset, or Zoom In at the most) would drop focus to
    // the page, out of reach of the lightbox's keys: it stays in the lightbox instead (T51).
    const focused = doc.activeElement;
    if (open && focused instanceof HTMLButtonElement && focused.disabled && root.contains(focused))
      root.focus({ preventScroll: true });
  };

  const show = () => {
    const image = images[index]!;
    img.src = image.source && usable(image) ? image.source.currentSrc || image.src : image.src;
    img.alt = image.alt;
    caption.textContent = image.alt;
    caption.hidden = image.alt === '';
    // Named by its picture's alt text (the caption), or plainly when it has none.
    if (image.alt) {
      root.setAttribute('aria-labelledby', caption.id);
      root.removeAttribute('aria-label');
    } else {
      root.removeAttribute('aria-labelledby');
      root.setAttribute('aria-label', 'Image');
    }
    count.textContent = `${index + 1} of ${images.length}`;
    zoom = 1;
    x = 0;
    y = 0;
    apply();
  };

  /** A point in the stage, from its centre (the picture's resting place). */
  const fromCentre = (clientX: number, clientY: number) => {
    const rect = stage.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };

  function zoomBy(factor: number, at?: { readonly x: number; readonly y: number }) {
    const next = clamp(zoom * factor);
    if (next === zoom) return;
    // The point under `at` (from the centre) stays where it is.
    const point = at ?? { x: 0, y: 0 };
    const ratio = next / zoom;
    x = point.x - (point.x - x) * ratio;
    y = point.y - (point.y - y) * ratio;
    zoom = next;
    if (zoom === 1) {
      x = 0;
      y = 0;
    }
    apply();
  }

  function reset() {
    zoom = 1;
    x = 0;
    y = 0;
    apply();
  }

  function step(delta: number) {
    if (images.length < 2) return;
    // The next picture still in the note: one removed since (its URL may be revoked) is skipped.
    let at = index;
    for (let tries = 1; tries < images.length; tries++) {
      at = (at + delta + images.length) % images.length;
      if (usable(images[at]!)) {
        index = at;
        show();
        return;
      }
    }
  }

  async function toggleFullScreen() {
    if (!canFullScreen) return;
    try {
      if (doc.fullscreenElement) await doc.exitFullscreen();
      else await root.requestFullscreen();
    } catch {
      // Refused (no user gesture, a policy): the lightbox stays as it is.
    }
  }
  const onFullScreenChange = () => {
    const full = doc.fullscreenElement === root;
    fullScreen.replaceChildren(icon(doc, full ? ICONS.exitFullScreen : ICONS.fullScreen));
    const label = full ? 'Exit Full Screen' : 'Full Screen';
    fullScreen.setAttribute('aria-label', label);
    fullScreen.dataset['tip'] = label;
  };
  doc.addEventListener('fullscreenchange', onFullScreenChange);

  const focusable = () =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].filter(
      (element) => !element.hidden && !element.disabled,
    );

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const key = event.key;
    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => undefined);
      else close();
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      step(key === 'ArrowLeft' ? -1 : 1);
    } else if (key === '+' || key === '=') {
      event.preventDefault();
      zoomBy(ZOOM_STEP);
    } else if (key === '-' || key === '_') {
      event.preventDefault();
      zoomBy(1 / ZOOM_STEP);
    } else if (key === '0') {
      event.preventDefault();
      reset();
    } else if (key === 'Tab') {
      // Focus stays in the lightbox.
      const items = focusable();
      if (items.length === 0) return;
      const at = items.indexOf(doc.activeElement as HTMLButtonElement);
      const nextAt = event.shiftKey
        ? at <= 0
          ? items.length - 1
          : at - 1
        : at === -1 || at === items.length - 1
          ? 0
          : at + 1;
      event.preventDefault();
      items[nextAt]!.focus();
    }
  };
  root.addEventListener('keydown', onKeyDown);
  // Focus that leaves (a click on the page behind is caught by the backdrop) comes back.
  const onFocusIn = (event: FocusEvent) => {
    if (open && !root.contains(event.target as Node | null)) root.focus({ preventScroll: true });
  };
  doc.addEventListener('focusin', onFocusIn);

  // The backdrop (the stage around the picture) closes it; the picture does not. Only a click
  // pressed in the lightbox: the click a phone sends after the double tap that opened it (pressed
  // on the note's picture, before the lightbox was there) lands on the backdrop too (T51).
  let pressed = false;
  let fromHere = false;
  /** Presses in the lightbox since it opened. */
  let presses = 0;
  root.addEventListener(
    'pointerdown',
    () => {
      pressed = true;
      presses += 1;
    },
    true,
  );
  root.addEventListener(
    'click',
    () => {
      fromHere = pressed;
      pressed = false;
    },
    true,
  );
  stage.addEventListener('click', (event) => {
    if (!fromHere || event.target !== stage || moved || onPicture(event)) return;
    close();
  });
  root.addEventListener('click', (event) => {
    if (fromHere && event.target === root) close();
  });

  // The wheel zooms at the pointer: a trackpad's pinch arrives as a wheel with Ctrl.
  stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const delta = event.deltaY * unit;
      if (delta === 0) return;
      zoomBy(Math.exp(-delta * (event.ctrlKey || event.metaKey ? 0.01 : 0.002)), {
        ...fromCentre(event.clientX, event.clientY),
      });
    },
    { passive: false },
  );

  // Safari's own pinch (gesture events, with a scale from the gesture's start).
  let gestureStart = 1;
  stage.addEventListener('gesturestart', (event) => {
    event.preventDefault();
    gestureStart = zoom;
  });
  stage.addEventListener('gesturechange', (event) => {
    event.preventDefault();
    const scale = (event as Event & { scale?: number }).scale ?? 1;
    zoomBy(clamp(gestureStart * scale) / zoom);
  });

  // Pointers: one drags (when zoomed in), two pinch.
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { startX: number; startY: number; originX: number; originY: number } | null = null;
  let pinch: { distance: number } | null = null;
  /** The last press moved the picture: its click is not the backdrop's. */
  let moved = false;
  const pinchDistance = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  /** Keeps the pointers' moves on the stage while a drag or pinch runs off the picture. */
  const capture = () => {
    for (const id of pointers.keys()) {
      try {
        stage.setPointerCapture?.(id);
      } catch {
        // A pointer that has already gone: nothing to capture.
      }
    }
  };
  /** Whether a click landed on the picture (it is not the backdrop's). */
  const onPicture = (event: MouseEvent) => {
    const box = img.getBoundingClientRect();
    return (
      box.width > 0 &&
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom
    );
  };
  const pinchCentre = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2) : { x: 0, y: 0 };
  };
  stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    moved = false;
    // Captured only once it drags or pinches (below): a plain click or double click keeps
    // its own target, the picture, so it zooms rather than reaching the backdrop.
    if (pointers.size === 2) {
      drag = null;
      pinch = { distance: pinchDistance() };
    } else if (pointers.size === 1) {
      drag = { startX: event.clientX, startY: event.clientY, originX: x, originY: y };
    }
  });
  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size >= 2) {
      const distance = pinchDistance();
      if (pinch.distance > 0 && distance > 0) {
        if (!moved) capture();
        moved = true;
        zoomBy(distance / pinch.distance, pinchCentre());
        pinch.distance = distance;
      }
      return;
    }
    if (!drag || zoom <= 1) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) capture();
    moved = true;
    x = drag.originX + dx;
    y = drag.originY + dy;
    apply();
  });
  const release = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) drag = null;
    else if (pointers.size === 1) {
      // The finger left on the screen carries on dragging from here.
      const [rest] = [...pointers.values()];
      drag = { startX: rest!.x, startY: rest!.y, originX: x, originY: y };
    }
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  // A double click (a double tap) on the picture: twice the size there, or fitted again. Not the
  // `dblclick` a phone sends just after the double tap that opened it: pressed on the note's
  // picture before the lightbox was there, it lands on this one and would open it zoomed (T51).
  // A double click of its own was pressed here twice.
  const offDouble = onDoubleActivate(img, (event) => {
    event.preventDefault();
    if (event.type === 'dblclick' && presses < 2) return;
    if (zoom > 1) reset();
    else zoomBy(2, fromCentre(event.clientX, event.clientY));
  });

  function close() {
    if (!open) return;
    open = false;
    if (current === lightbox) current = null;
    offDouble();
    doc.removeEventListener('focusin', onFocusIn);
    doc.removeEventListener('fullscreenchange', onFullScreenChange);
    if (doc.fullscreenElement === root) void doc.exitFullscreen().catch(() => undefined);
    root.remove();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    afterClose?.();
    afterClose = undefined;
    options.onClose?.();
  }

  const lightbox: Lightbox = {
    element: root,
    get index() {
      return index;
    },
    get zoom() {
      return zoom;
    },
    get offset() {
      return { x, y };
    },
    get open() {
      return open;
    },
    zoomBy,
    reset,
    step,
    close,
  };
  current = lightbox;
  show();
  doc.body.append(root);
  root.focus({ preventScroll: true });
  const undo = hooks.onOpen?.(lightbox);
  if (open) afterClose = undo ?? undefined;
  else undo?.();
  return lightbox;
}
