/**
 * Moving around the sidebar calendar with the keyboard (T39 pass 2, A523). The calendar is
 * one Tab stop, as a grid is: the arrows move by a day or a week, Home and End go to the
 * week's Monday and Sunday, and Page Up and Page Down to the same day a month away. The
 * week-number column sits left of Monday: Left from a Monday reaches its week, Right from a
 * week its Monday.
 */
import { addDays, isoWeekday, plainDate, type PlainDate } from '@penmoss/core/periodic';

/** A focusable cell: a day, or a week (named by its Monday). */
export type CalendarCell =
  | { readonly kind: 'day'; readonly date: PlainDate }
  | { readonly kind: 'week'; readonly monday: PlainDate };

export const dayCell = (date: PlainDate): CalendarCell => ({ kind: 'day', date });

export const weekCell = (date: PlainDate): CalendarCell => ({
  kind: 'week',
  monday: addDays(date, 1 - isoWeekday(date)),
});

/** A stable key for a cell, as its button's `data-cell`. */
export function cellKey(cell: CalendarCell): string {
  return cell.kind === 'day' ? `d:${cell.date.toString()}` : `w:${cell.monday.toString()}`;
}

/** The month a cell belongs to: a day's own, a week's by its Thursday (as ISO weeks are). */
export function cellMonth(cell: CalendarCell): { year: number; month: number } {
  const date = cell.kind === 'day' ? cell.date : addDays(cell.monday, 3);
  return { year: date.year, month: date.month };
}

/** The same day `months` months away, or that month's last day when it is shorter. */
function addMonths(date: PlainDate, months: number): PlainDate {
  const index = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  for (let day = date.day; day > 27; day--) {
    try {
      return plainDate(year, month, day);
    } catch {
      // A shorter month: try the day before.
    }
  }
  return plainDate(year, month, Math.min(date.day, 28));
}

/** Where `key` moves focus from `cell`; null for a key the calendar does not handle. */
export function moveCell(cell: CalendarCell, key: string): CalendarCell | null {
  if (cell.kind === 'week') {
    switch (key) {
      case 'ArrowRight':
      case 'Home':
        return dayCell(cell.monday);
      case 'End':
        return dayCell(addDays(cell.monday, 6));
      case 'ArrowUp':
        return weekCell(addDays(cell.monday, -7));
      case 'ArrowDown':
        return weekCell(addDays(cell.monday, 7));
      case 'PageUp':
        return weekCell(addMonths(cell.monday, -1));
      case 'PageDown':
        return weekCell(addMonths(cell.monday, 1));
      case 'ArrowLeft':
        return cell; // The first column: nothing further left.
      default:
        return null;
    }
  }
  const { date } = cell;
  switch (key) {
    case 'ArrowLeft':
      return isoWeekday(date) === 1 ? weekCell(date) : dayCell(addDays(date, -1));
    case 'ArrowRight':
      return dayCell(addDays(date, 1));
    case 'ArrowUp':
      return dayCell(addDays(date, -7));
    case 'ArrowDown':
      return dayCell(addDays(date, 7));
    case 'Home':
      return dayCell(addDays(date, 1 - isoWeekday(date)));
    case 'End':
      return dayCell(addDays(date, 7 - isoWeekday(date)));
    case 'PageUp':
      return dayCell(addMonths(date, -1));
    case 'PageDown':
      return dayCell(addMonths(date, 1));
    default:
      return null;
  }
}
