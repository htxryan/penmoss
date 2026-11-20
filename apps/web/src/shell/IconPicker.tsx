/**
 * The icon and symbol picker (A1568): one modal for every place a person chooses an icon or a
 * character. Its tabs are Icons (Lucide's, about 2,000) and Characters (symbols and emoji,
 * `@penmoss/core/characters`); a caller offers one or both. Each loads its list from its own
 * chunk as it opens.
 *
 * The search field has the focus from the start and filters by name and by Lucide's tags or the
 * characters' keywords (`findGlyphs`); a pasted character finds itself, or is offered as it is.
 * The grid below draws only the rows in view (`icon-grid.ts`). ← → ↑ ↓, Page Up and Down, and
 * ⌘/Ctrl+Home and End move through it from the field; Return picks, Escape closes. The chosen
 * one is marked; each cell's name is its accessible name and its tooltip, and the footer says
 * the active one's. Recently Used, first with an empty search, is this device's.
 */
import type { CharacterEntry } from '@penmoss/core/characters';
import { findGlyphs } from '@penmoss/core/glyph-search';
import { glyphKey } from '@penmoss/core/line-symbols';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { DialogClose } from './DialogClose';
import { useTrackedDialog } from '../analytics/dialog';
import { devicePref, useDevicePref } from './device-pref';
import {
  cellLabel,
  gridLayout,
  gridStep,
  rowsInView,
  type GridMetrics,
  type GridSection,
} from './icon-grid';
import { LUCIDE_PREFIX, LucideSvg, lucideName, rememberLucideIcon } from './lucide';
import type { IconEntry } from './lucide-catalog';
import { PickerOverlay } from './picker';
import './icon-picker.css';

export type PickerTab = 'icons' | 'characters';

/** What the grid holds: an icon (its value `lucide:<name>`) or a character (its glyph). */
interface Cell {
  readonly value: string;
  /** Its name in Title Case: the cell's accessible name and tooltip. */
  readonly label: string;
  readonly icon?: IconEntry;
  readonly glyph?: string;
}

const TAB_LABELS: Readonly<Record<PickerTab, string>> = {
  icons: 'Icons',
  characters: 'Characters',
};

/** Cells are square, this many pixels; a heading's row is shorter. */
const METRICS: GridMetrics = { cell: 40, head: 30 };
/** How many a Recently Used row keeps. */
const RECENT_MAX = 16;

const recentPrefs = {
  icons: devicePref<readonly string[]>('penmoss.recentIcons', recentOptions()),
  characters: devicePref<readonly string[]>('penmoss.recentCharacters', recentOptions()),
};

function recentOptions() {
  return {
    parse: (stored: string | null): readonly string[] => {
      try {
        const value: unknown = JSON.parse(stored ?? '[]');
        return Array.isArray(value)
          ? value.filter((each): each is string => typeof each === 'string').slice(0, RECENT_MAX)
          : [];
      } catch {
        return [];
      }
    },
    serialise: (value: readonly string[]) => (value.length > 0 ? JSON.stringify(value) : null),
  };
}

/** The list a tab shows, once its chunk is in. */
type Loaded = {
  readonly icons?: readonly IconEntry[];
  readonly characters?: readonly CharacterEntry[];
};

function useLists(tab: PickerTab): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({});
  useEffect(() => {
    let live = true;
    if (tab === 'icons' && !loaded.icons) {
      void import('./lucide-catalog').then(({ ICONS }) => {
        if (live) setLoaded((now) => ({ ...now, icons: ICONS }));
      });
    }
    if (tab === 'characters' && !loaded.characters) {
      void import('@penmoss/core/characters')
        .then(({ loadCharacters }) => loadCharacters())
        .then((characters) => {
          if (live) setLoaded((now) => ({ ...now, characters }));
        });
    }
    return () => {
      live = false;
    };
  }, [tab, loaded.icons, loaded.characters]);
  return loaded;
}

/** What two values are compared by: a character without its variation selectors. */
const keyOf = (tab: PickerTab, value: string): string =>
  tab === 'characters' ? glyphKey(value) : value;

const iconCell = (icon: IconEntry): Cell => ({
  value: `${LUCIDE_PREFIX}${icon.name}`,
  label: cellLabel(icon.name),
  icon,
});
const characterCell = (character: CharacterEntry): Cell => ({
  value: character.glyph,
  label: cellLabel(character.name),
  glyph: character.glyph,
});

export function IconPicker({
  title,
  tabs,
  initialTab,
  value,
  testId,
  problemOf,
  onPick,
  onClose,
}: {
  /** The dialog's heading, in Title Case ("Choose an Icon"). */
  readonly title: string;
  /** The tabs it offers, in order; one tab shows no tab row. */
  readonly tabs: readonly PickerTab[];
  readonly initialTab?: PickerTab;
  /** The current choice (`lucide:star`, or a glyph), marked in the grid. */
  readonly value: string | null;
  readonly testId: string;
  /** Why a character cannot be picked (taken by another symbol, against the rules), or null. */
  readonly problemOf?: (value: string) => string | null;
  /** Stores the pick; a sentence saying why not keeps the picker open with it. */
  readonly onPick: (value: string, tab: PickerTab) => string | null | void;
  readonly onClose: () => void;
}) {
  const id = useId();
  const tracked = useTrackedDialog('iconPicker');
  const [tab, setTab] = useState<PickerTab>(initialTab ?? tabs[0] ?? 'icons');
  const [query, setQuery] = useState('');
  // The active cell; null: the chosen one (or the first) until a key, the pointer or a search
  // moves it.
  const [active, setActive] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const lists = useLists(tab);
  const [recent, setRecent] = useDevicePref(recentPrefs[tab]);
  const input = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 320, width: 0 });

  useLayoutEffect(() => input.current?.focus(), [tab]);
  useLayoutEffect(() => {
    const element = scroller.current;
    const inner = grid.current;
    if (!element || !inner) return;
    // The grid's own width (inside the scroller's padding) sets how many cells fit a row.
    const measure = () =>
      setView((now) => ({ ...now, height: element.clientHeight, width: inner.clientWidth }));
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);

  const loading = tab === 'icons' ? !lists.icons : !lists.characters;
  const sections = useMemo((): readonly GridSection<Cell>[] => {
    if (tab === 'icons') {
      const icons = lists.icons ?? [];
      if (query.trim() !== '')
        return [{ label: null, items: findGlyphs(icons, query).map(iconCell) }];
      const byName = new Map(icons.map((icon) => [icon.name, icon]));
      const recentCells = recent
        .map((each) => byName.get(lucideName(each) ?? ''))
        .filter((icon): icon is IconEntry => icon !== undefined)
        .map(iconCell);
      return [
        { label: 'Recently Used', items: recentCells },
        { label: recentCells.length > 0 ? 'All Icons' : null, items: icons.map(iconCell) },
      ];
    }
    const characters = lists.characters ?? [];
    if (query.trim() !== '') {
      const found = findGlyphs(characters, query).map(characterCell);
      // A pasted character that is not in the list is offered as it is, when the rules allow it
      // (they refuse letters and digits, so a word typed to search is never offered).
      const pasted = query.trim();
      const listed = found.some((cell) => glyphKey(cell.value) === glyphKey(pasted));
      const own =
        !listed && problemOf && !problemOf(pasted)
          ? [{ value: pasted, label: `Use ${pasted}`, glyph: pasted }]
          : [];
      return [{ label: null, items: [...own, ...found] }];
    }
    const byGlyph = new Map(characters.map((each) => [glyphKey(each.glyph), each]));
    const recentCells = recent.map((glyph): Cell => {
      const known = byGlyph.get(glyphKey(glyph));
      return known ? characterCell(known) : { value: glyph, label: glyph, glyph };
    });
    const groups = new Map<string, Cell[]>();
    for (const each of characters) {
      const cells = groups.get(each.group) ?? [];
      cells.push(characterCell(each));
      groups.set(each.group, cells);
    }
    return [
      { label: 'Recently Used', items: recentCells },
      ...[...groups].map(([label, items]) => ({ label, items })),
    ];
  }, [tab, lists.icons, lists.characters, query, recent, problemOf]);

  const columns = Math.max(1, Math.floor((view.width || 600) / METRICS.cell));
  const layout = useMemo(() => gridLayout(sections, columns, METRICS), [sections, columns]);
  const count = layout.items.length;
  const chosenKey = value === null ? null : keyOf(tab, value);
  const isChosen = (cell: Cell) => chosenKey !== null && keyOf(tab, cell.value) === chosenKey;
  // Its first place: in Recently Used when it is there, so the grid opens at the top.
  const chosenAt = useMemo(
    () =>
      chosenKey === null
        ? -1
        : layout.items.findIndex((cell) => keyOf(tab, cell.value) === chosenKey),
    [layout, chosenKey, tab],
  );
  const current = Math.min(active ?? Math.max(chosenAt, 0), Math.max(0, count - 1));
  const activeCell = layout.items[current];
  const cellId = (index: number) => `${id}-cell-${index}`;
  // A pasted character the rules refuse (no letters: a word is a search), said as it is typed.
  const pasted = query.trim();
  const pastedProblem =
    tab === 'characters' &&
    problemOf &&
    pasted !== '' &&
    !/[\p{L}\p{N}]/u.test(pasted) &&
    !layout.items.some((cell) => keyOf(tab, cell.value) === keyOf(tab, pasted))
      ? problemOf(pasted)
      : null;
  const said = problem ?? pastedProblem;

  // The active row is kept in view as it moves (the chosen one's as the grid fills).
  useLayoutEffect(() => {
    const element = scroller.current;
    const place = layout.places[current];
    if (!element || !place) return;
    const row = layout.rows[place.row]!;
    // A heading just above the first row comes into view with it.
    const previous = layout.rows[place.row - 1];
    const top = previous?.kind === 'head' ? previous.top : row.top;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (row.top + METRICS.cell > element.scrollTop + element.clientHeight) {
      element.scrollTop = row.top + METRICS.cell - element.clientHeight;
    }
  }, [current, layout]);

  const pick = (cell: Cell | undefined) => {
    if (!cell) return;
    const refused =
      (tab === 'characters' ? problemOf?.(cell.value) : null) ?? onPick(cell.value, tab) ?? null;
    if (refused) {
      setProblem(refused);
      return;
    }
    if (cell.icon) rememberLucideIcon(cell.icon.name, cell.icon.node);
    const key = keyOf(tab, cell.value);
    setRecent(
      [cell.value, ...recent.filter((each) => keyOf(tab, each) !== key)].slice(0, RECENT_MAX),
    );
    tracked.done();
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      pick(activeCell);
      return;
    }
    // Plain Home and End move the caret in the field; with ⌘ or Ctrl, to the grid's ends.
    if ((event.key === 'Home' || event.key === 'End') && !event.metaKey && !event.ctrlKey) return;
    // ← and → with Shift select the field's text.
    if (event.shiftKey || event.altKey) return;
    const page = Math.max(1, Math.floor(view.height / METRICS.cell) - 1);
    const next = gridStep(layout, current, event.key, page);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    setProblem(null);
  };

  const chooseTab = (next: PickerTab) => {
    if (next === tab) return;
    setTab(next);
    setQuery('');
    setActive(null);
    setProblem(null);
    scroller.current?.scrollTo({ top: 0 });
  };

  const shown = rowsInView(layout, view.top, view.height, METRICS);
  const noun = tab === 'icons' ? 'icons' : 'characters';
  const titleId = `${id}-title`;
  return (
    <PickerOverlay testId={testId} className="icon-picker" labelledBy={titleId} onClose={onClose}>
      <div className="dlg-title">
        <h2 id={titleId}>{title}</h2>
        <DialogClose label="Close" onClose={onClose} />
      </div>
      {tabs.length > 1 ? (
        <div className="icon-picker-tabs" role="tablist" aria-label="Kind">
          {tabs.map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              className="icon-picker-tab"
              data-ui="option"
              data-event="icon-picker.tab"
              aria-selected={tab === each}
              tabIndex={tab === each ? 0 : -1}
              data-testid={`${testId}-tab-${each}`}
              onClick={() => chooseTab(each)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const at = tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1);
                chooseTab(tabs[(at + tabs.length) % tabs.length]!);
              }}
            >
              {TAB_LABELS[each]}
            </button>
          ))}
        </div>
      ) : null}
      <div className="dlg-search">
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-grid`}
          aria-autocomplete="list"
          aria-activedescendant={count > 0 && !loading ? cellId(current) : undefined}
          aria-label={tab === 'icons' ? 'Search Icons' : 'Search Characters'}
          placeholder={
            tab === 'icons'
              ? 'Search icons by name or tag'
              : 'Search symbols and emoji, or paste one'
          }
          autoComplete="off"
          spellCheck={false}
          value={query}
          data-testid={`${testId}-search`}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setProblem(null);
            scroller.current?.scrollTo({ top: 0 });
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        ref={scroller}
        className="icon-picker-scroll"
        data-testid={`${testId}-grid`}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          setView((now) => (now.top === top ? now : { ...now, top }));
        }}
      >
        <div
          ref={grid}
          id={`${id}-grid`}
          role="listbox"
          aria-label={TAB_LABELS[tab]}
          aria-busy={loading || undefined}
          className="icon-picker-grid"
          style={{ height: `${layout.height}px` }}
        >
          {shown.map((row) =>
            row.kind === 'head' ? (
              <div
                key={`head-${row.label}`}
                className="icon-picker-head"
                role="presentation"
                style={{ top: `${row.top}px` }}
              >
                {row.label}
              </div>
            ) : (
              <div
                key={`row-${row.first}`}
                className="icon-picker-row"
                role="presentation"
                style={{ top: `${row.top}px` }}
              >
                {row.items.map((cell, column) => {
                  const index = row.first + column;
                  const chosen = isChosen(cell);
                  const refused =
                    tab === 'characters' && !chosen ? (problemOf?.(cell.value) ?? null) : null;
                  return (
                    <div
                      key={cell.value}
                      id={cellId(index)}
                      role="option"
                      className="icon-picker-cell"
                      data-event="icon-picker.icon"
                      aria-selected={index === current}
                      aria-current={chosen || undefined}
                      aria-disabled={refused ? true : undefined}
                      aria-label={refused ? `${cell.label}, ${refused}` : cell.label}
                      data-tip={refused ? `${cell.label} · ${refused}` : cell.label}
                      data-tip-on="hover"
                      data-value={cell.value}
                      data-testid={`${testId}-cell`}
                      onMouseMove={() => {
                        if (index !== current) setActive(index);
                      }}
                      // The field keeps the focus, so the keys still reach it.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pick(cell)}
                    >
                      {cell.icon ? (
                        <LucideSvg node={cell.icon.node} name={cell.icon.name} size={20} />
                      ) : (
                        <span className="icon-picker-glyph" aria-hidden="true">
                          {cell.glyph}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ),
          )}
        </div>
        {loading ? (
          <p className="dlg-empty icon-picker-empty">Loading…</p>
        ) : count === 0 ? (
          <p className="dlg-empty icon-picker-empty" data-testid={`${testId}-empty`}>
            No {noun} match “{query.trim()}”.
          </p>
        ) : null}
      </div>
      {said ? (
        <p className="icon-picker-problem" role="alert" data-testid={`${testId}-problem`}>
          {said}
        </p>
      ) : null}
      <div className="dlg-foot" aria-live="polite">
        <span className="icon-picker-name grow" data-testid={`${testId}-active`}>
          {activeCell ? activeCell.label : ''}
        </span>
        <span>
          {loading
            ? ''
            : query.trim() === ''
              ? `${(tab === 'icons' ? lists.icons : lists.characters)?.length.toLocaleString() ?? ''} ${noun}`
              : `${count.toLocaleString()} found`}
        </span>
        <span className="keys" aria-hidden="true">
          <kbd>↩</kbd> Pick
        </span>
        <span className="keys" aria-hidden="true">
          <kbd>esc</kbd> Close
        </span>
      </div>
    </PickerOverlay>
  );
}
