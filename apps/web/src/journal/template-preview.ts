/** Settings → Daily Notes' template editor (A78; PEN-146): its placeholders and its preview. */

/** The template placeholders (A78), in the order the + Placeholder menu lists them. */
export const PLACEHOLDERS: ReadonlyArray<{ readonly name: string; readonly label: string }> = [
  { name: 'date', label: 'Date' },
  { name: 'longDate', label: 'Long Date' },
  { name: 'weekday', label: 'Weekday' },
  { name: 'week', label: 'Week' },
  { name: 'month', label: 'Month' },
  { name: 'year', label: 'Year' },
];

/** One line of the preview: what the note shows for a line of filled-in markdown. */
export interface PreviewLine {
  readonly kind: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'task' | 'item' | 'quote' | 'text';
  readonly text: string;
  readonly done?: boolean;
  readonly marker?: string;
}

/**
 * A filled-in template as the lines the preview draws: headings, task and list items, quotes and
 * text. Blank lines are the gaps between them. Inline marks stay as typed: it is a sketch of the
 * note's shape, not a second renderer.
 */
export function previewLines(markdown: string): PreviewLine[] {
  const lines: PreviewLine[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      lines.push({ kind: `h${heading[1]!.length}` as PreviewLine['kind'], text: heading[2]! });
      continue;
    }
    const task = /^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/.exec(line);
    if (task) {
      lines.push({ kind: 'task', text: task[2]!, done: task[1] !== ' ' });
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      lines.push({ kind: 'item', text: item[2]!, marker: /\d/.test(item[1]!) ? item[1]! : '•' });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      lines.push({ kind: 'quote', text: quote[1]! });
      continue;
    }
    lines.push({ kind: 'text', text: line.trim() });
  }
  return lines;
}
