import { Icon } from '@penmoss/ui/icons';
import { useCallback } from 'react';
import { slotElements, useShownToasts, type ToastTone } from './toasts';

/**
 * The window's one toast stack (PEN-63): fixed at the bottom centre, above the status bar
 * while it shows, newest at the bottom. It is the one `role="status"` region every toast is
 * announced through, and it never takes the pointer: only a toast with controls does.
 */
export function ToastStack() {
  const shown = useShownToasts();
  return (
    <div role="status" className="toast-stack" data-testid="toast-stack">
      {shown.map((entry) =>
        entry.kind === 'slot' ? (
          <SlotPlace key={entry.id} id={entry.id} />
        ) : (
          <p
            key={entry.id}
            className="toast"
            data-tone={entry.tone}
            data-testid={entry.testId}
            data-leaving={entry.leaving ? '' : undefined}
          >
            <ToneGlyph tone={entry.tone} />
            <span className="toast-text">{entry.text}</span>
          </p>
        ),
      )}
    </div>
  );
}

/** A check for a success, a warning for a refusal or failure, nothing otherwise. */
export function ToneGlyph({ tone }: { readonly tone: ToastTone }) {
  if (tone === 'done') return <Icon name="check" className="toast-glyph" />;
  if (tone === 'error') return <Icon name="warning" className="toast-glyph" />;
  return null;
}

/** Where a `ToastSlot` renders its toast. */
function SlotPlace({ id }: { readonly id: number }) {
  const ref = useCallback((element: HTMLDivElement | null) => slotElements.set(id, element), [id]);
  return <div className="toast-slot" ref={ref} />;
}
