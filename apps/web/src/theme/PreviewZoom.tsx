/**
 * A Settings preview that opens larger (A1589): over the inert preview lies one button, **Enlarge
 * <Name> Preview**, which shows a magnifying glass over a soft dim on hover and on keyboard
 * focus. It opens a modal dialog, **<Name> Preview**, with the same preview drawn as large as the
 * window allows (at its real size when there is room), live as the page's settings change. Close
 * (×), Escape and a click on the backdrop close it, and the focus goes back to the button; Tab
 * stays inside it meanwhile (the modal focus trap, focus-trap.ts).
 *
 * `children` draws the preview: `false` for the page's own, `true` for the dialog's, so each
 * preview chooses its larger form (its scale, its test id).
 */
import { Icon } from '@penmoss/ui/icons';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DialogClose } from '../shell/DialogClose';
import { useTrackedDialog } from '../analytics/dialog';

export function PreviewZoom({
  name,
  testId,
  children,
}: {
  /** What it previews, in Title Case: "Appearance", "Sidebar". */
  readonly name: string;
  /** The button's test id; the dialog's is `${testId}-dialog`. */
  readonly testId: string;
  readonly children: (enlarged: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div className="preview-zoom">
      {children(false)}
      <button
        ref={button}
        type="button"
        className="preview-zoom-button"
        data-ui="item"
        data-testid={testId}
        aria-label={`Enlarge ${name} Preview`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="preview-zoom-icon" aria-hidden="true">
          <Icon name="zoom-in" size={22} />
        </span>
      </button>
      {open ? (
        <PreviewDialog name={name} testId={`${testId}-dialog`} onClose={close}>
          {children(true)}
        </PreviewDialog>
      ) : null}
    </div>
  );
}

function PreviewDialog({
  name,
  testId,
  onClose,
  children,
}: {
  readonly name: string;
  readonly testId: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const id = useId();
  useTrackedDialog('previewZoom');
  const dialog = useRef<HTMLDivElement>(null);
  // The focus starts on Close, the dialog's one control.
  useLayoutEffect(() => {
    dialog.current?.querySelector<HTMLElement>('.dlg-close')?.focus();
  }, []);
  return createPortal(
    <div
      className="overlay preview-zoom-overlay"
      data-testid={`${testId}-backdrop`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // Settings' own Escape (back to the note) waits for the next one.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        ref={dialog}
        className="dialog preview-zoom-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        data-testid={testId}
      >
        <div className="dlg-title">
          <h2 id={`${id}-title`}>{`${name} Preview`}</h2>
          <DialogClose label="Close" onClose={onClose} />
        </div>
        <div className="preview-zoom-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
