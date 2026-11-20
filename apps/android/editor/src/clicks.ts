/**
 * The tracked controls inside the note (PEN-175): the editor's own widgets (a callout's fold, a
 * code block's Copy, a task's check box) carry the same `data-event` ids on the phone as on the
 * Mac, and this page tells the app of each use, which records `click <id>` as the Mac's page
 * does (apps/web/src/analytics/track.ts, installClickTracking). One capture-phase listener reads
 * the nearest `[data-event]` control; a `[data-command]` control is counted by its command's run,
 * so it records nothing here. A select or a range input is counted once when it changes (a
 * slider when it is let go), never its value. The app checks each id against its catalogue and
 * drops any other.
 */
import { BRIDGE_VERSION, type FromEditor } from './protocol';

/** Which way a switch or a check box goes with this click, or undefined for any other control. */
export function clickState(control: Element): 'on' | 'off' | undefined {
  if (control instanceof HTMLInputElement) {
    if (control.type !== 'checkbox' && control.type !== 'radio') return undefined;
    // A click toggles a check box before its listeners run, so this is the new state.
    return control.checked ? 'on' : 'off';
  }
  const checked = control.getAttribute('aria-checked') ?? control.getAttribute('aria-pressed');
  if (checked === null) return undefined;
  // The widget redraws after the click: this is still the old state.
  return checked === 'true' ? 'off' : 'on';
}

/** A control counted when its value changes rather than when it is clicked. */
function changes(control: Element): boolean {
  return (
    control instanceof HTMLSelectElement ||
    (control instanceof HTMLInputElement && control.type === 'range')
  );
}

/** The tracked control [target] belongs to, or null when there is none or it is off. */
function trackedControl(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const control = target.closest('[data-event], [data-command]');
  if (!control || control.hasAttribute('data-command')) return null;
  if (
    (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) &&
    control.disabled
  )
    return null;
  if (control.getAttribute('aria-disabled') === 'true') return null;
  return control.getAttribute('data-event') ? control : null;
}

/**
 * Posts a `click` message for each use of a tracked control in `doc` while `active` says so (not
 * in the theme preview's sample note); returns its removal.
 */
export function installClickTracking(
  doc: Document,
  post: (message: FromEditor) => void,
  active: () => boolean = () => true,
): () => void {
  const send = (control: Element, state: 'on' | 'off' | undefined) => {
    if (!active()) return;
    const id = control.getAttribute('data-event');
    if (!id) return;
    post(
      state === undefined
        ? { v: BRIDGE_VERSION, type: 'click', id }
        : { v: BRIDGE_VERSION, type: 'click', id, state },
    );
  };
  const onClick = (event: MouseEvent) => {
    try {
      const control = trackedControl(event.target);
      if (!control || changes(control)) return;
      send(control, clickState(control));
    } catch {
      // Recording never breaks a click.
    }
  };
  const onChange = (event: Event) => {
    try {
      const control = trackedControl(event.target);
      if (control && changes(control)) send(control, undefined);
    } catch {
      // Recording never breaks a change.
    }
  };
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('change', onChange, true);
  return () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('change', onChange, true);
  };
}
