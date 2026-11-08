import { Icon } from '@penmoss/ui/icons';
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { fuzzy, highlightRuns } from '../commands/fuzzy';
import { DialogClose } from '../shell/DialogClose';
import type { FolderChoice } from './model';

export interface FolderPickerProps {
  /** The note's title, for the dialog's name ("3 notes" for several). */
  readonly title: string;
  /** How many notes move (T42, A570): one dialog for every selected note. */
  readonly count?: number;
  readonly choices: readonly FolderChoice[];
  /** Where the notes are now (null: the top level; undefined: several places). */
  readonly currentId: string | null | undefined;
  readonly onChoose: (folderId: string | null) => void;
  readonly onClose: () => void;
  /** The dialog's name when it is not a move to a folder (T68: to another notebook). */
  readonly label?: string;
  /** The search field's hint and Enter's action (T68: "Copy to…", "Copy here"). */
  readonly placeholder?: string;
  readonly action?: string;
}

/**
 * "Move to folder…" (T39): the palette's combobox over the top level and
 * every folder, indented as in the tree and found by path ("work deep").
 * Before it, a note changed folders only by dragging it in the tree, which
 * neither the keyboard nor a phone's touch could do.
 */
export function FolderPicker({
  title,
  count = 1,
  choices,
  currentId,
  onChoose,
  onClose,
  label: named,
  placeholder = 'Move to folder…',
  action = 'Move here',
}: FolderPickerProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      choices.findIndex((choice) => choice.id === currentId),
    ),
  );
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const items = useMemo(() => {
    const q = query.trim();
    return choices.flatMap((choice) => {
      if (!q) return [{ choice, indices: [] as readonly number[], filtered: false }];
      const match = fuzzy(q, choice.path);
      return match ? [{ choice, indices: match.indices, filtered: true }] : [];
    });
  }, [choices, query]);
  const current = Math.min(active, Math.max(0, items.length - 1));

  useLayoutEffect(() => input.current?.focus(), []);
  useLayoutEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [current, items]);

  const choose = (choice: FolderChoice | undefined) => {
    if (choice) onChoose(choice.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const count = Math.max(1, items.length);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((current + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((current - 1 + count) % count);
        break;
      case 'Enter':
        event.preventDefault();
        choose(items[current]?.choice);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
    }
  };

  const option = (index: number) => `${id}-option-${index}`;
  const label =
    named ??
    (count === 1 ? `Move “${title || 'Untitled'}” to a folder` : `Move ${count} notes to a folder`);
  return (
    <div
      className="overlay"
      data-testid="folder-picker"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="dialog palette folder-picker"
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <div className="dlg-search">
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={items.length > 0 ? option(current) : undefined}
            aria-label="Folder"
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <DialogClose label="Close the Folder Picker" onClose={onClose} />
        </div>
        <div ref={list} className="dlg-list" id={`${id}-list`} role="listbox" aria-label="Folders">
          {items.length === 0 ? (
            <p className="dlg-empty" role="status">
              No folder matches “{query}”
            </p>
          ) : (
            items.map(({ choice, indices, filtered }, index) => (
              <div
                key={choice.id ?? 'top'}
                id={option(index)}
                role="option"
                className="opt folder-opt"
                aria-selected={index === current}
                aria-current={choice.id === currentId ? 'location' : undefined}
                data-index={index}
                // Indented by depth as in the tree, capped in CSS (six levels on a phone, A363).
                style={filtered ? undefined : ({ '--depth': choice.depth } as CSSProperties)}
                onMouseMove={() => {
                  if (index !== current) setActive(index);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(choice)}
              >
                <span className="oic" aria-hidden="true">
                  <Icon
                    name={choice.id === null ? 'list' : choice.notebook ? 'notebook' : 'folder'}
                    size={14}
                  />
                </span>
                <span className="ot">
                  {/* Filtered, a folder shows its path, so two "Notes" folders differ. */}
                  {(filtered
                    ? highlightRuns(choice.path, indices)
                    : [{ text: choice.name, match: false }]
                  ).map((run, i) =>
                    run.match ? <b key={i}>{run.text}</b> : <span key={i}>{run.text}</span>,
                  )}
                </span>
                <span className="os">
                  {choice.id === currentId ? (
                    <>
                      <span className="sr-only">Here now</span>
                      <Icon name="check" size={14} />
                    </>
                  ) : null}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="dlg-foot" aria-hidden="true">
          <span className="keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
          </span>
          Choose
          <span className="keys">
            <kbd>↵</kbd>
          </span>
          {action}
          <span className="grow" />
          <span className="keys">
            <kbd>Esc</kbd>
          </span>
          Cancel
        </div>
      </div>
    </div>
  );
}
