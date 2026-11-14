/**
 * History's words for times, days, writers and line counts (Ryan's review of #192, finding 13):
 * the one-line rows under each day's heading.
 */
import type { HistoryAuthor } from './source';

/** A version's day and time: Nov 13, 4:48 PM. */
export const time = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** A row's time: the day is its group's heading. */
export const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Midnight of the day `ms` falls on, here. */
export function startOfDay(ms: number): number {
  const day = new Date(ms);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
}

/** A day's heading: Today, Yesterday, Nov 13, or Nov 13, 2025 in another year. */
export function dayLabel(ms: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  const date = new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  if (days === 0) return 'Today';
  if (days === 1) return `Yesterday, ${date}`;
  return date;
}

/** `+3 −1 lines` as its two numbers; null for any other summary (`Title changed`). */
export function lineCounts(summary: string): { added: number; removed: number } | null {
  const match = /^\+(\d+) −(\d+) lines?$/.exec(summary);
  return match ? { added: Number(match[1]), removed: Number(match[2]) } : null;
}

/** A writer's name as History's tooltip says it: `Agent · Claude Code`, `Penmoss for Mac`. */
export const authorName = (author: HistoryAuthor) =>
  author.kind === 'agent' ? `Agent · ${author.label}` : author.label;

/** A version's markdown without its frontmatter (the title and tags): what Copy Text copies. */
export function bodyOf(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown;
  const end = markdown.indexOf('\n---', 4);
  return end < 0 ? markdown : markdown.slice(end + 4).replace(/^\n+/, '');
}
