import { useTrackedDialog } from '../analytics/dialog';
import { CaptureForm } from './CaptureForm';
import { ModalOverlay } from '../shell/ModalOverlay';

/** The app's Capture command (T30): the capture form over the page; a save or Escape closes it. */
export function CaptureDialog({ onClose }: { onClose: (restoreFocus?: boolean) => void }) {
  const tracked = useTrackedDialog('capture');
  return (
    <ModalOverlay
      testId="capture-dialog"
      className="capture-dlg"
      label="Quick Capture"
      onClose={() => onClose()}
    >
      <CaptureForm
        onSaved={() => {
          tracked.done();
          onClose();
        }}
        onCancel={() => onClose()}
      />
    </ModalOverlay>
  );
}
