import { useId, useLayoutEffect, useRef } from 'react';
import { PickerListbox, PickerOverlay } from '../shell/picker';
import { usePickerList } from '../shell/picker-list';
import { displayTitle, type NoteListEntry } from '../notes/list';
import { Kbd } from './Kbd';

export interface RecentSwitcherProps {
  /** Most recently used first; the open note (if any) first of all. */
  readonly notes: readonly NoteListEntry[];
  readonly currentId: string | null;
  /** The highlighted entry. */
  readonly index: number;
  /** Opened with the modifier held: releasing it opens the highlighted note. */
  readonly held: boolean;
  readonly combo: string | undefined;
  readonly onIndexChange: (index: number) => void;
  readonly onChoose: (id: string) => void;
  readonly onClose: () => void;
}

const ago = (time: number) => {
  if (!time) return '';
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(time).toLocaleDateString();
};

/**
 * The ⌘E recent-notes switcher (T20), like an app switcher: ⌘E opens it on
 * the previous note, each further E (still holding ⌘) moves on, ⇧ moves
 * back, and letting go of ⌘ opens the highlighted note. Without the
 * modifier held (opened from the palette) ↑/↓ and Enter work instead.
 */
export function RecentSwitcher({
  notes,
  currentId,
  index,
  held,
  combo,
  onIndexChange,
  onChoose,
  onClose,
}: RecentSwitcherProps) {
  const id = useId();
  const latest = useRef({ notes, index, onChoose });
  useLayoutEffect(() => {
    latest.current = { notes, index, onChoose };
  });

  // Letting go of the modifier that opened it chooses the highlighted note (attached before paint).
  useLayoutEffect(() => {
    if (!held) return;
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Meta' && event.key !== 'Control') return;
      const note = latest.current.notes[latest.current.index];
      if (note) latest.current.onChoose(note.id);
    };
    window.addEventListener('keyup', onKeyUp, true);
    return () => window.removeEventListener('keyup', onKeyUp, true);
  }, [held]);

  const picker = usePickerList({
    items: notes,
    active: index,
    setActive: onIndexChange,
    onChoose: (at) => {
      const note = notes[at];
      if (note) onChoose(note.id);
    },
    onClose,
    optionName: 'recent',
  });
  return (
    <PickerOverlay
      testId="recent-switcher"
      className="mru"
      labelledBy={`${id}-title`}
      onClose={onClose}
    >
      <div className="dlg-title">
        <h2 id={`${id}-title`}>Recent notes</h2>
        <span className="muted">
          <Kbd combo={combo} /> again to move on · let go to open
        </span>
      </div>
      {/* The list takes the keys: with many recent notes its options overflow it. */}
      <PickerListbox picker={picker} label="Recent notes" focus>
        {notes.length === 0 ? (
          <p className="dlg-empty">No notes yet.</p>
        ) : (
          notes.map((note, i) => (
            <div
              key={note.id}
              {...picker.optionProps(i)}
              // The pointer does not move the highlight: letting go of ⌘ opens it.
              onMouseMove={undefined}
              className="opt"
              onClick={() => onChoose(note.id)}
            >
              <span className="mru-num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="two">
                <span className="t">
                  {displayTitle(note.title)}
                  {note.id === currentId ? <span className="muted"> · open now</span> : null}
                </span>
                <span className="s">Edited {ago(note.updatedAt)}</span>
              </span>
            </div>
          ))
        )}
      </PickerListbox>
    </PickerOverlay>
  );
}
