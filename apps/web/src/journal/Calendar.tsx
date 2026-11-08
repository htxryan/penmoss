import { Icon } from '@penmoss/ui/icons';
import {
  addDays,
  isoWeek,
  isoWeekday,
  longDate,
  parsePlainDate,
  plainDate,
  type PlainDate,
} from '@penmoss/core/periodic';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useCommand, useCommands } from '../commands/hooks';
import { useNoteList, useNotes } from '../notes/hooks';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import { SectionHead } from '../shell/SectionHead';
import { openPeriodic, today as todayOf } from './journal';
import {
  cellKey,
  cellMonth,
  dayCell,
  moveCell,
  weekCell,
  type CalendarCell,
} from './calendar-keys';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAY_HEADS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const OPEN_KEY = 'penmoss.calendar.open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** The six Monday-first weeks shown for a month. */
function monthGrid(year: number, month: number): PlainDate[][] {
  const first = plainDate(year, month, 1);
  const start = addDays(first, 1 - isoWeekday(first));
  return [0, 1, 2, 3, 4, 5].map((week) =>
    [0, 1, 2, 3, 4, 5, 6].map((day) => addDays(start, week * 7 + day)),
  );
}

/**
 * The journal calendar in the sidebar (T19): a month with the days that have
 * a daily note marked (and the weeks with a weekly note), from the local
 * replica. Choosing a day or a week number opens its note, creating it from
 * the template when there is none.
 */
export function Calendar({
  activeId,
  tools,
}: {
  activeId: string | null;
  /** The section's drag handle and ✕ (T53 item 8). */
  tools?: ReactNode;
}) {
  const notes = useNotes();
  const workspace = useWorkspace();
  const commands = useCommands();
  const list = useNoteList();
  useWorkspaceState(); // the time zone setting
  const today = todayOf(workspace.settings());
  const [shown, setShown] = useState({ year: today.year, month: today.month });
  // Today in another month (the synced time zone arrived after the first render or changed, or
  // midnight passed into a new month): the calendar shows that month, with today in it.
  const todayMonth = today.year * 12 + today.month;
  const [shownFor, setShownFor] = useState(todayMonth);
  if (shownFor !== todayMonth) {
    setShownFor(todayMonth);
    setShown({ year: today.year, month: today.month });
  }
  const [open, setOpen] = useState(readOpen);
  const grid = useRef<HTMLTableElement>(null);
  const ids = useMemo(() => new Set(list.map((entry) => entry.id)), [list]);
  /** The cell the keyboard is on (A523): the calendar's one Tab stop. */
  const [cursor, setCursor] = useState<CalendarCell | null>(null);
  /** Moved by a key: focus follows once the month it is in shows. */
  const moved = useRef(false);

  const toggle = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, String(next));
    } catch {
      // Private windows may refuse storage; the calendar still works.
    }
  };

  useCommand('journal.calendar', () => {
    toggle(true);
    setShown({ year: today.year, month: today.month });
    requestAnimationFrame(() =>
      grid.current?.querySelector<HTMLElement>('[aria-current="date"]')?.focus(),
    );
  });

  const step = (months: number) => {
    const index = shown.year * 12 + (shown.month - 1) + months;
    setShown({ year: Math.floor(index / 12), month: (index % 12) + 1 });
  };

  const openDay = (date: PlainDate) =>
    void openPeriodic(notes, workspace, 'daily', date.toString());
  const openWeek = (week: string) => void openPeriodic(notes, workspace, 'weekly', week);

  const weeks = monthGrid(shown.year, shown.month);
  const shownKeys = new Set(
    weeks.flatMap((days) => [cellKey(weekCell(days[0]!)), ...days.map((d) => cellKey(dayCell(d)))]),
  );
  // The one cell Tab reaches: where the keyboard last was, else the open note's day or week,
  // else today, else the month's first day.
  const activeKey =
    activeId === null
      ? null
      : (weeks
          .flatMap((days) => [
            {
              key: cellKey(weekCell(days[0]!)),
              id: notes.periodicId('weekly', isoWeek(days[0]!).toString()),
            },
            ...days.map((d) => ({
              key: cellKey(dayCell(d)),
              id: notes.periodicId('daily', d.toString()),
            })),
          ])
          .find((cell) => cell.id === activeId)?.key ?? null);
  const firstOfMonth = cellKey(dayCell(plainDate(shown.year, shown.month, 1)));
  const todayKey = cellKey(dayCell(today));
  const tabStop =
    cursor && shownKeys.has(cellKey(cursor))
      ? cellKey(cursor)
      : (activeKey ??
        (today.year === shown.year && today.month === shown.month ? todayKey : firstOfMonth));

  useEffect(() => {
    if (!moved.current || !cursor) return;
    moved.current = false;
    grid.current?.querySelector<HTMLElement>(`[data-cell="${cellKey(cursor)}"]`)?.focus();
  }, [cursor, shown]);

  const onGridKey = (event: KeyboardEvent<HTMLTableElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const from = (event.target as HTMLElement).closest<HTMLElement>('[data-cell]')?.dataset['cell'];
    if (!from) return;
    const [kind, iso] = [from.slice(0, 1), from.slice(2)];
    const date = parsePlainDate(iso);
    if (!date) return;
    const next = moveCell(kind === 'w' ? weekCell(date) : dayCell(date), event.key);
    if (!next) return;
    event.preventDefault();
    moved.current = true;
    setCursor(next);
    // The month shown follows the cell (a day from the next month, Page Down).
    const month = cellMonth(next);
    if (month.year !== shown.year || month.month !== shown.month) setShown(month);
  };

  return (
    <section
      className="calendar"
      aria-labelledby="calendar-name"
      data-testid="calendar"
      data-collapsed={open ? undefined : 'true'}
    >
      {/* The sections' title row (A988); the month and its buttons below it, so the section's
          tools sit at the row's end as every section's do, clear of the month's buttons. */}
      <SectionHead
        name="Calendar"
        nameId="calendar-name"
        collapsed={!open}
        onToggle={() => toggle(!open)}
        controls="calendar-body"
        tools={tools}
      />
      {open ? (
        <div className="calendar-nav">
          <span id="calendar-heading" className="calendar-month">
            {MONTHS[shown.month - 1]} {shown.year}
          </span>
          <button
            type="button"
            className="icon-btn"
            data-ui="item"
            aria-label="Previous Month"
            data-tip="Previous Month"
            onClick={() => step(-1)}
          >
            <Icon name="chevL" size={14} />
          </button>
          <button
            type="button"
            className="btn quiet calendar-today"
            data-command="journal.today"
            onClick={() => commands.run('journal.today')}
          >
            Today
          </button>
          <button
            type="button"
            className="icon-btn"
            data-ui="item"
            aria-label="Next Month"
            data-tip="Next Month"
            onClick={() => step(1)}
          >
            <Icon name="chevR" size={14} />
          </button>
        </div>
      ) : null}
      {open ? (
        // A grid (A523): one Tab stop, the arrow keys move within it.
        <table
          ref={grid}
          id="calendar-body"
          role="grid"
          className="calendar-grid"
          aria-labelledby="calendar-heading"
          onKeyDown={onGridKey}
        >
          <thead>
            <tr>
              <th scope="col" className="calendar-wk">
                <abbr title="ISO week">Wk</abbr>
              </th>
              {DAY_HEADS.map((day) => (
                <th key={day} scope="col">
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((days) => {
              const week = isoWeek(days[0]!).toString();
              const weekId = notes.periodicId('weekly', week);
              return (
                <tr key={week}>
                  <th scope="row" className="calendar-wk">
                    <button
                      type="button"
                      className="calendar-week"
                      data-ui="item"
                      data-cell={cellKey(weekCell(days[0]!))}
                      tabIndex={tabStop === cellKey(weekCell(days[0]!)) ? 0 : -1}
                      onFocus={() => setCursor(weekCell(days[0]!))}
                      data-has-note={ids.has(weekId) ? 'true' : undefined}
                      aria-pressed={activeId === weekId}
                      aria-label={`Week ${week}${ids.has(weekId) ? ', has a note' : ''}`}
                      onClick={() => openWeek(week)}
                    >
                      {week.slice(6)}
                    </button>
                  </th>
                  {days.map((date) => {
                    const id = notes.periodicId('daily', date.toString());
                    const isToday = date.toString() === today.toString();
                    return (
                      <td key={date.toString()} role="gridcell">
                        <button
                          type="button"
                          className="calendar-day"
                          data-ui="item"
                          data-cell={cellKey(dayCell(date))}
                          tabIndex={tabStop === cellKey(dayCell(date)) ? 0 : -1}
                          onFocus={() => setCursor(dayCell(date))}
                          data-date={date.toString()}
                          data-outside={date.month !== shown.month ? 'true' : undefined}
                          data-has-note={ids.has(id) ? 'true' : undefined}
                          aria-current={isToday ? 'date' : undefined}
                          aria-pressed={activeId === id}
                          aria-label={`${longDate(date)}${ids.has(id) ? ', has a note' : ''}`}
                          onClick={() => openDay(date)}
                        >
                          {date.day}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
