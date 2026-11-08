import { ariaKeyShortcuts, formatCombo } from '@penmoss/editor/keys';
import { Select } from '@penmoss/ui/controls/Select';
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNotes } from '../notes/hooks';
import { useSourcesState } from '../sources/hooks';
import { useWorkspace } from '../workspace/hooks';
import { captureStart } from './into';
import { destinationOf, saveCapture, type CaptureDestination, type SavedCapture } from './save';

const SAVE_KEYS = 'Mod+Enter';

/**
 * The quick-capture form (T30): a text field, where it goes (today's note or
 * a new note in Inbox), ⌘Enter (Ctrl+Enter) to save and Escape to cancel.
 * Used by the app's Capture dialog and the Mac capture window. It starts on
 * the default chosen in Settings → Daily Notes every time; choosing the other
 * here is for this capture only (T51 item 19, A947).
 *
 * What is typed is a draft until it is saved or cancelled: the Mac window
 * hides when it loses focus (a notification, a stray click), and shown again
 * it still has the text (T30 review).
 */
export function CaptureForm({
  onSaved,
  onCancel,
  focusKey = 0,
  settingsKey = 0,
  prepare,
}: {
  onSaved: (saved: SavedCapture) => void;
  onCancel: () => void;
  /** Changing it refocuses the field (the Mac window is shown again); the draft stays. */
  focusKey?: number;
  /**
   * Changing it says the settings may have changed (another window stored
   * them): with no draft typed, the default destination is read again.
   */
  settingsKey?: number;
  /** Runs before a save (the Mac window reads what other windows stored). */
  prepare?: () => Promise<void>;
}) {
  const scopedNotes = useNotes();
  const scopedWorkspace = useWorkspace();
  // Which notebook it goes into (A888, A914): chosen here when there is more than one.
  const sources = useSourcesState();
  const places = sources && sources.all.length > 1 ? sources.all : null;
  const [into, setInto] = useState<string | null>(() => (sources ? captureStart(sources) : null));
  const target = places ? (places.find((place) => place.id === into) ?? null) : null;
  const notes = target?.notes ?? scopedNotes;
  const workspace = target?.workspace ?? scopedWorkspace;
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [destination, setDestination] = useState<CaptureDestination>(() =>
    destinationOf(workspace.settings()),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The notebook was picked for this capture (A914): it holds until the capture ends. */
  const [picked, setPicked] = useState(false);
  const [shownFor, setShownFor] = useState(focusKey);
  const [readFor, setReadFor] = useState(settingsKey);
  if (shownFor !== focusKey || readFor !== settingsKey) {
    const shown = shownFor !== focusKey;
    setShownFor(focusKey);
    setReadFor(settingsKey);
    setError(null);
    // A draft keeps the destination and notebook chosen with it. An empty form reads the
    // default destination again (A947); only a new show starts the notebook afresh, and never
    // one picked for this capture (A914).
    if (text === '') {
      const start = shown && !picked ? (sources ? captureStart(sources) : null) : into;
      if (start !== into) setInto(start);
      const place = places?.find((one) => one.id === start);
      setDestination(destinationOf((place?.workspace ?? workspace).settings()));
    }
  }
  useLayoutEffect(() => field.current?.focus(), [focusKey]);

  /** The next capture starts on the default again (A947). */
  const reset = () => {
    setText('');
    setPicked(false);
    setDestination(destinationOf(workspace.settings()));
  };

  const cancel = () => {
    reset();
    setError(null);
    onCancel();
  };

  const choosing = places !== null && target === null;
  const save = async () => {
    if (saving || text.trim() === '' || choosing) return;
    setSaving(true);
    setError(null);
    try {
      await prepare?.();
      const saved = await saveCapture(notes, workspace, text, destination);
      reset();
      onSaved(saved);
    } catch (problem) {
      console.error('[capture] could not save', problem);
      setError('Could not save the capture. It is still here; try again.');
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      void save();
    }
  };

  return (
    <form
      className="capture"
      data-testid="capture-form"
      aria-labelledby={`${id}-title`}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 id={`${id}-title`} className="capture-title">
        Quick Capture
      </h2>
      <label className="sr-only" htmlFor={`${id}-text`}>
        Capture
      </label>
      <textarea
        id={`${id}-text`}
        ref={field}
        className="capture-text"
        data-testid="capture-text"
        value={text}
        placeholder="What’s on your mind?"
        rows={4}
        onChange={(event) => setText(event.target.value)}
      />
      {places ? (
        <label className="capture-into">
          <span>Into</span>
          <Select
            data-testid="capture-into"
            value={into ?? ''}
            onChange={(event) => {
              setInto(event.target.value);
              setPicked(true);
              const place = places.find((one) => one.id === event.target.value);
              if (place) setDestination(destinationOf(place.workspace.settings()));
            }}
          >
            {target === null ? (
              <option value="" disabled>
                Choose a notebook
              </option>
            ) : null}
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
      <div className="capture-foot">
        <fieldset className="capture-dest">
          <legend className="sr-only">Save to</legend>
          <label>
            <input
              type="radio"
              name={`${id}-dest`}
              value="daily"
              checked={destination === 'daily'}
              onChange={() => setDestination('daily')}
            />
            Today’s Note
          </label>
          <label>
            <input
              type="radio"
              name={`${id}-dest`}
              value="inbox"
              checked={destination === 'inbox'}
              onChange={() => setDestination('inbox')}
            />
            New Note in Inbox
          </label>
        </fieldset>
        <div className="row">
          <button type="button" className="btn quiet" data-ui="dismiss" onClick={cancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            data-ui="submit"
            data-testid="capture-save"
            disabled={saving || text.trim() === '' || choosing}
            aria-keyshortcuts={ariaKeyShortcuts([SAVE_KEYS])}
          >
            Save <span className="keys">{formatCombo(SAVE_KEYS)}</span>
          </button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="capture-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
