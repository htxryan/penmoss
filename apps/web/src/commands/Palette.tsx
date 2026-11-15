import { tabIntentOf, type TabIntent } from './tab-intent';
import { Icon } from '@penmoss/ui/icons';
import { DialogClose } from '../shell/DialogClose';
import { PickerField, PickerListbox, PickerOverlay } from '../shell/picker';
import { usePickerList } from '../shell/picker-list';
import { useMemo, useState } from 'react';
import { displayTitle, type NoteListEntry } from '../notes/list';
import type { CommandDefinition } from './definitions';
import { fuzzyMatch, highlightRuns, type FuzzyMatch } from '@penmoss/core/fuzzy';
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
  /** `where`: a new tab, behind (⌘↩) or in front (⇧⌘↩), PEN-140; else this one. */
  readonly onOpenNote: (id: string, where?: TabIntent) => void;
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
      const match = fuzzyMatch(q, command.title, { scattered: false });
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
      const match = fuzzyMatch(q, displayTitle(note.title), { scattered: false });
      if (match) found.push({ kind: 'note', key: `note:${note.id}`, note, match, group: 'Notes' });
    }
    return found.sort((a, b) => b.match.score - a.match.score).slice(0, MAX_RESULTS);
  }, [commands, version, mode, notes, query]);

  const choose = (item: Item | undefined, where?: TabIntent) => {
    if (!item) return;
    if (item.kind === 'command') onRunCommand(item.command.id);
    else if (where) onOpenNote(item.note.id, where);
    else onOpenNote(item.note.id);
  };
  const picker = usePickerList({
    items,
    active,
    setActive,
    onChoose: (index, event) => choose(items[index], tabIntentOf(event)),
    onClose,
  });

  const label = mode === 'all' ? 'Command Palette' : 'Quick Open';
  let lastGroup: string | null = null;
  return (
    <PickerOverlay
      testId={mode === 'all' ? 'palette' : 'quick-open'}
      className="palette"
      label={label}
      onClose={onClose}
    >
      <div className="dlg-search">
        <PickerField
          picker={picker}
          aria-label={label}
          placeholder={mode === 'all' ? 'Type a command or a note…' : 'Open a note by title…'}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <DialogClose
          label={mode === 'all' ? 'Close the Palette' : 'Close Quick Open'}
          onClose={onClose}
        />
      </div>
      <PickerListbox picker={picker} label={`${label} results`}>
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
                {...picker.optionProps(index)}
                className="opt"
                data-kind={item.kind}
                onClick={(event) => choose(item, tabIntentOf(event))}
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
      </PickerListbox>
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
    </PickerOverlay>
  );
}
