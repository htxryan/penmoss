import { Icon } from '@penmoss/ui/icons';
import {
  addDays,
  addWeeks,
  isoWeek,
  longDate,
  parseIsoWeek,
  parsePlainDate,
  weekDays,
} from '@penmoss/core/periodic';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { useCommand, useCommands } from '../commands/hooks';
import { useNoteList, useNotes } from '../notes/hooks';
import { useWorkspace } from '../workspace/hooks';
import { openPeriodic, thisWeek, today } from './journal';
import { usePeriod } from './period';

/**
 * Above a daily note: the previous and next day and its week; above a weekly
 * note: the previous and next week and its seven days (T19). A day or week
 * without a note is created from the template when chosen.
 */
export function PeriodNav({ replica }: { replica: Yjs14Replica | null }) {
  const notes = useNotes();
  const workspace = useWorkspace();
  const commands = useCommands();
  const list = useNoteList();
  const current = usePeriod(replica);

  const go = (kind: 'daily' | 'weekly', period: string) =>
    void openPeriodic(notes, workspace, kind, period);
  const neighbour = (step: number) => {
    if (!current) return;
    if (current.kind === 'daily') {
      const date = parsePlainDate(current.period);
      if (date) go('daily', addDays(date, step).toString());
    } else {
      const week = parseIsoWeek(current.period);
      if (week) go('weekly', addWeeks(week, step).toString());
    }
  };
  const weekOf = () => {
    const date = current?.kind === 'daily' ? parsePlainDate(current.period) : null;
    if (date) go('weekly', isoWeek(date).toString());
  };
  const enabled = () => current !== null;
  useCommand('journal.previous', () => neighbour(-1), enabled);
  useCommand('journal.next', () => neighbour(1), enabled);
  useCommand('journal.week', weekOf, () => current?.kind === 'daily');

  if (!current) return null;
  const has = (kind: 'daily' | 'weekly', period: string) =>
    list.some((entry) => entry.id === notes.periodicId(kind, period));

  if (current.kind === 'daily') {
    const date = parsePlainDate(current.period);
    if (!date) return null;
    const week = isoWeek(date).toString();
    return (
      <nav className="period-nav" aria-label="Daily notes" data-testid="period-nav">
        <button
          type="button"
          className="btn quiet"
          data-command="journal.previous"
          onClick={() => commands.run('journal.previous')}
        >
          <Icon name="chevL" size={14} />
          {addDays(date, -1).toString()}
        </button>
        <span className="period-label">{longDate(date)}</span>
        <button
          type="button"
          className="btn quiet"
          data-command="journal.week"
          data-has-note={has('weekly', week) ? 'true' : undefined}
          onClick={() => commands.run('journal.week')}
        >
          <Icon name="week" size={14} />
          Week {week}
        </button>
        <button
          type="button"
          className="btn quiet"
          data-command="journal.next"
          onClick={() => commands.run('journal.next')}
        >
          {addDays(date, 1).toString()}
          <Icon name="chevR" size={14} />
        </button>
      </nav>
    );
  }

  const week = parseIsoWeek(current.period);
  if (!week) return null;
  return (
    <nav className="period-nav" aria-label="Weekly notes" data-testid="period-nav">
      <button
        type="button"
        className="btn quiet"
        data-command="journal.previous"
        onClick={() => commands.run('journal.previous')}
      >
        <Icon name="chevL" size={14} />
        {addWeeks(week, -1).toString()}
      </button>
      <ul className="period-days" role="list" aria-label="Days of this week">
        {weekDays(week).map((day) => (
          <li key={day.toString()}>
            <button
              type="button"
              className="period-day"
              data-ui="item"
              data-has-note={has('daily', day.toString()) ? 'true' : undefined}
              aria-label={longDate(day)}
              onClick={() => go('daily', day.toString())}
            >
              {longDate(day).slice(0, 3)} {day.day}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn quiet"
        data-command="journal.next"
        onClick={() => commands.run('journal.next')}
      >
        {addWeeks(week, 1).toString()}
        <Icon name="chevR" size={14} />
      </button>
    </nav>
  );
}

/** Today (⌘D) and This week (⌘⇧W, and ⌘⌥W or Alt+W, A90), wherever the notes view is shown. */
export function JournalCommands() {
  const notes = useNotes();
  const workspace = useWorkspace();
  useCommand('journal.today', () => {
    void openPeriodic(notes, workspace, 'daily', today(workspace.settings()).toString());
  });
  useCommand('journal.thisWeek', () => {
    void openPeriodic(notes, workspace, 'weekly', thisWeek(workspace.settings()));
  });
  return null;
}
