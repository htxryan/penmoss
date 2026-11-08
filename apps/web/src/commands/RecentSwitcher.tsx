import { useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
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
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const latest = useRef({ notes, index, onChoose });
  useLayoutEffect(() => {
    latest.current = { notes, index, onChoose };
  });

  useLayoutEffect(() => {
    list.current?.focus();
  }, []);

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

  const count = Math.max(1, notes.length);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        onIndexChange((index + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        onIndexChange((index - 1 + count) % count);
        break;
      case 'Enter': {
        event.preventDefault();
        const note = notes[index];
        if (note) onChoose(note.id);
        break;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
    }
  };

  const option = (i: number) => `${id}-recent-${i}`;
  return (
    <div
      className="overlay"
      data-testid="recent-switcher"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog mru" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <div className="dlg-title">
          <h2 id={`${id}-title`}>Recent notes</h2>
          <span className="muted">
            <Kbd combo={combo} /> again to move on · let go to open
          </span>
        </div>
        <div
          ref={list}
          className="dlg-list"
          role="listbox"
          // Tabbable, as a list that can scroll must be (axe's scrollable-region-focusable): with
          // many recent notes, or while the dialog opens, its options overflow it.
          tabIndex={0}
          aria-label="Recent notes"
          aria-activedescendant={notes.length > 0 ? option(index) : undefined}
          onKeyDown={onKeyDown}
        >
          {notes.length === 0 ? (
            <p className="dlg-empty">No notes yet.</p>
          ) : (
            notes.map((note, i) => (
              <div
                key={note.id}
                id={option(i)}
                role="option"
                className="opt"
                aria-selected={i === index}
                data-index={i}
                onMouseDown={(event) => event.preventDefault()}
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
        </div>
      </div>
    </div>
  );
}
