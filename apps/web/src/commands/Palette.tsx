import { Icon } from '@penmoss/ui/icons';
import { DialogClose } from '../shell/DialogClose';
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { displayTitle, type NoteListEntry } from '../notes/list';
import type { CommandDefinition } from './definitions';
import { fuzzy, highlightRuns, type FuzzyMatch } from './fuzzy';
import { useCommands, useCommandsVersion } from './hooks';
import { Kbd } from './Kbd';

export type PaletteMode = 'all' | 'notes';

type Item =
  | {
      readonly kind: 'command';
      readonly key: string;
      readonly command: CommandDefinition;
      readonly match: FuzzyMatch;
      readonly group: string;
    }
  | {
      readonly kind: 'note';
      readonly key: string;
      readonly note: NoteListEntry;
      readonly match: FuzzyMatch;
      readonly group: string;
    };

const MAX_RESULTS = 40;
const RECENT_IN_PALETTE = 5;

export interface PaletteProps {
  readonly mode: PaletteMode;
  /** Notes, most recently used first. */
  readonly notes: readonly NoteListEntry[];
  readonly onRunCommand: (id: string) => void;
  readonly onOpenNote: (id: string) => void;
  readonly onClose: () => void;
}

/**
 * The command palette (⌘K) and quick open (⌘P), T20: one fuzzy search over
 * the commands that can run now and the notes (or notes only). A WAI-ARIA
 * combobox: the input keeps focus, ↑/↓ move the active option
 * (`aria-activedescendant`), Enter runs it, Esc closes.
 */
export function Palette({ mode, notes, onRunCommand, onOpenNote, onClose }: PaletteProps) {
  const commands = useCommands();
  const version = useCommandsVersion();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const items = useMemo((): Item[] => {
    void version;
    const runnable =
      mode === 'all'
        ? [...commands.definitions.values()].filter(
            (command) => !command.hidden && commands.available(command.id),
          )
        : [];
    const q = query.trim();
    if (!q) {
      const recent = notes.slice(0, mode === 'all' ? RECENT_IN_PALETTE : MAX_RESULTS);
      return [
        ...recent.map((note): Item => ({
          kind: 'note',
          key: `note:${note.id}`,
          note,
          match: { score: 0, indices: [] },
          group: 'Recent notes',
        })),
        ...runnable.map((command): Item => ({
          kind: 'command',
          key: `command:${command.id}`,
          command,
          match: { score: 0, indices: [] },
          group: command.area,
        })),
      ];
    }
    const found: Item[] = [];
    for (const command of runnable) {
      const match = fuzzy(q, command.title);
      if (match) {
        found.push({
          kind: 'command',
          key: `command:${command.id}`,
          command,
          match,
          group: 'Commands',
        });
      }
    }
    for (const note of notes) {
      const match = fuzzy(q, displayTitle(note.title));
      if (match) found.push({ kind: 'note', key: `note:${note.id}`, note, match, group: 'Notes' });
    }
    return found.sort((a, b) => b.match.score - a.match.score).slice(0, MAX_RESULTS);
  }, [commands, version, mode, notes, query]);

  const current = Math.min(active, Math.max(0, items.length - 1));

  useLayoutEffect(() => {
    input.current?.focus();
  }, []);

  useLayoutEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [current, items]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === 'command') onRunCommand(item.command.id);
    else onOpenNote(item.note.id);
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
      case 'Home':
      case 'End':
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        setActive(event.key === 'Home' ? 0 : count - 1);
        break;
      case 'Enter':
        event.preventDefault();
        choose(items[current]);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
    }
  };

  const label = mode === 'all' ? 'Command Palette' : 'Quick Open';
  const option = (index: number) => `${id}-option-${index}`;
  let lastGroup: string | null = null;
  return (
    <div
      className="overlay"
      data-testid={mode === 'all' ? 'palette' : 'quick-open'}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog palette" role="dialog" aria-modal="true" aria-label={label}>
        <div className="dlg-search">
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={items.length > 0 ? option(current) : undefined}
            aria-label={label}
            placeholder={mode === 'all' ? 'Type a command or a note…' : 'Open a note by title…'}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <DialogClose
            label={mode === 'all' ? 'Close the Palette' : 'Close Quick Open'}
            onClose={onClose}
          />
        </div>
        <div
          ref={list}
          className="dlg-list"
          id={`${id}-list`}
          role="listbox"
          aria-label={`${label} results`}
        >
          {items.length === 0 ? (
            <p className="dlg-empty" role="status">
              No matches for “{query}”
            </p>
          ) : (
            items.map((item, index) => {
              const header =
                item.group !== lastGroup ? (
                  <div className="grp-h" role="presentation" key={`group:${item.group}:${index}`}>
                    {item.group}
                  </div>
                ) : null;
              lastGroup = item.group;
              const title =
                item.kind === 'command' ? item.command.title : displayTitle(item.note.title);
              return [
                header,
                <div
                  key={item.key}
                  id={option(index)}
                  role="option"
                  className="opt"
                  aria-selected={index === current}
                  data-index={index}
                  data-kind={item.kind}
                  onMouseMove={() => {
                    if (index !== current) setActive(index);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item)}
                >
                  <span className="oic" aria-hidden="true">
                    <Icon name={item.kind === 'command' ? 'command' : 'file'} size={14} />
                  </span>
                  <span className="ot">
                    {highlightRuns(title, item.match.indices).map((run, i) =>
                      run.match ? <b key={i}>{run.text}</b> : <span key={i}>{run.text}</span>,
                    )}
                    {item.kind === 'command' && query.trim() ? (
                      <span className="p">{item.command.area}</span>
                    ) : null}
                  </span>
                  <span className="os">
                    {item.kind === 'command' ? (
                      <Kbd combo={commands.keysOf(item.command.id)[0]} />
                    ) : (
                      'Note'
                    )}
                  </span>
                </div>,
              ];
            })
          )}
        </div>
        <div className="dlg-foot" aria-hidden="true">
          <span className="keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
          </span>
          Navigate
          <span className="keys">
            <kbd>↵</kbd>
          </span>
          {mode === 'all' ? 'Run' : 'Open'}
          <span className="grow" />
          <span className="keys">
            <kbd>Esc</kbd>
          </span>
          Close
        </div>
      </div>
    </div>
  );
}
