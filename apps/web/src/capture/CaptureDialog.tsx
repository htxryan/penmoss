import { useTrackedDialog } from '../analytics/dialog';
import { CaptureForm } from './CaptureForm';

/** The app's Capture command (T30): the capture form over the page; a save or Escape closes it. */
export function CaptureDialog({ onClose }: { onClose: (restoreFocus?: boolean) => void }) {
  const tracked = useTrackedDialog('capture');
  return (
    <div
      className="overlay"
      data-testid="capture-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dialog capture-dlg"
        role="dialog"
        aria-modal="true"
        aria-label="Quick Capture"
      >
        <CaptureForm
          onSaved={() => {
            tracked.done();
            onClose();
          }}
          onCancel={() => onClose()}
        />
      </div>
    </div>
  );
}
