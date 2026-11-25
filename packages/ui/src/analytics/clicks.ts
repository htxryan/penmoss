/**
 * The tracked clicks (PEN-137, PEN-175): one capture-phase listener for every page that records
 * its controls, the Mac's and the web's (apps/web/src/analytics/track.ts) and Android's editor
 * page (apps/android/editor/src/host.ts), so the two can't drift.
 *
 * It reads the nearest `[data-event]` control and hands its id to `send`. A `[data-command]`
 * control is counted once, by its command's run, so a click whose nearest tracked control has a
 * `data-command` sends nothing here; nor does a disabled control (`disabled` or
 * `aria-disabled="true"`). A switch or a check box also says which way it went (`on` or `off`).
 * A select or a slider (`<input type="range">`) sends once per change instead, a slider when it
 * is let go, never the value it was given. Each page decides what to do with the id: the Mac's
 * records it, Android's posts it to the app, which checks it against its catalogue.
 */

/** Which way a switch or a check box went. */
export type ClickState = 'on' | 'off';

/** Called once per use of a tracked control: its id, and for a switch or a check box its state. */
export type SendClick = (id: string, state: ClickState | undefined) => void;

/** Which way a switch or a check box goes with this click, or undefined for any other control. */
function clickState(control: Element): ClickState | undefined {
  if (control instanceof HTMLInputElement) {
    if (control.type !== 'checkbox' && control.type !== 'radio') return undefined;
    // A click toggles a check box before its listeners run, so this is the new state.
    return control.checked ? 'on' : 'off';
  }
  const checked = control.getAttribute('aria-checked') ?? control.getAttribute('aria-pressed');
  if (checked === null) return undefined;
  // The page redraws after the click: this is still the old state.
  return checked === 'true' ? 'off' : 'on';
}

/** A control counted when its value changes rather than when it is clicked. */
function changesOnly(control: Element): boolean {
  return (
    control instanceof HTMLSelectElement ||
    (control instanceof HTMLInputElement && control.type === 'range')
  );
}

/** The tracked control `target` belongs to and its id, or null when there is none or it is off. */
function tracked(target: EventTarget | null): { control: Element; id: string } | null {
  if (!(target instanceof Element)) return null;
  const control = target.closest('[data-event], [data-command]');
  if (!control || control.hasAttribute('data-command')) return null;
  const native =
    control instanceof HTMLButtonElement ||
    control instanceof HTMLSelectElement ||
    control instanceof HTMLInputElement;
  if (native && control.disabled) return null;
  if (control.getAttribute('aria-disabled') === 'true') return null;
  const id = control.getAttribute('data-event');
  return id ? { control, id } : null;
}

/** Listens in `doc` for each use of a tracked control and calls `send`; returns its removal. */
export function installClickListener(doc: Document, send: SendClick): () => void {
  const onClick = (event: MouseEvent) => {
    try {
      const found = tracked(event.target);
      if (!found || changesOnly(found.control)) return;
      send(found.id, clickState(found.control));
    } catch {
      // Recording never breaks a click.
    }
  };
  const onChange = (event: Event) => {
    try {
      const found = tracked(event.target);
      if (found && changesOnly(found.control)) send(found.id, undefined);
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
