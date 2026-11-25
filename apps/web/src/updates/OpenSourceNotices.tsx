/**
 * Open Source Notices (A1580): a row on Settings → Updates, the page with the version, whose
 * button shows `third-party-notices.txt` (the licences of what Penmoss ships from others, A1568)
 * in a dialog. A dialog, not a link to the file: in the Mac app a link to one of the app's own
 * files would replace the app's page with it.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { SettingRow } from '../theme/look-rows';

/** Where the page serves the notices from (`apps/web/public/`). */
const NOTICES_URL = '/third-party-notices.txt';

type Loaded = { readonly text: string } | { readonly failed: true } | null;

function useNotices(): Loaded {
  const [loaded, setLoaded] = useState<Loaded>(null);
  useEffect(() => {
    let live = true;
    fetch(NOTICES_URL)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error())))
      .then(
        (text) => live && setLoaded({ text }),
        () => live && setLoaded({ failed: true }),
      );
    return () => {
      live = false;
    };
  }, []);
  return loaded;
}

function NoticesDialog({ onClose }: { readonly onClose: () => void }) {
  const loaded = useNotices();
  return (
    <ConfirmDialog
      title="Open Source Notices"
      testId="notices-dialog"
      className="confirm notices-dialog"
      onCancel={onClose}
      onSubmit={onClose}
    >
      {loaded === null ? (
        <p role="status">Loading…</p>
      ) : 'failed' in loaded ? (
        <p role="alert">The notices could not be read.</p>
      ) : (
        <pre className="notices-text" tabIndex={0} data-testid="notices-text">
          {loaded.text}
        </pre>
      )}
      <div className="confirm-actions">
        <button
          data-event="settings.updates.open-source-notices.done"
          type="submit"
          className="btn primary"
          data-ui="submit"
          autoFocus
        >
          Done
        </button>
      </div>
    </ConfirmDialog>
  );
}

export function OpenSourceNotices() {
  const id = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const shown = useRef(false);
  // Focus back on the button once the dialog is gone: while it is open the page behind it is
  // inert, so focusing the button as it closes does nothing.
  useEffect(() => {
    if (shown.current && !open) button.current?.focus();
    shown.current = open;
  }, [open]);
  return (
    <div className="lf-group updates-notices">
      <SettingRow
        setting="open-source-notices"
        label="Open Source Notices"
        labelId={`${id}-label`}
        help="The licences of the open source software Penmoss includes, such as Lucide’s icons."
        helpId={`${id}-help`}
      >
        <button
          data-event="settings.updates.open-source-notices.show"
          ref={button}
          type="button"
          className="btn"
          data-ui="menu"
          aria-haspopup="dialog"
          aria-describedby={`${id}-help`}
          data-testid="open-source-notices"
          onClick={() => setOpen(true)}
        >
          Show Notices
        </button>
      </SettingRow>
      {open ? <NoticesDialog onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
