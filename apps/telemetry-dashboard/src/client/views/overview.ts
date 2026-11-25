/** The dashboard's Overview view. */
import { lineChart } from '../charts';
import { CLIENT_LABELS, titled } from '../names';
import { slot, daysOf, pivot, card, tiles, type Answer, rowsOf, actorCard } from '../cards';

export function overview(answer: Answer): HTMLElement[] {
  const totals = answer['totals'] as { today?: number; last7?: number; last30?: number };
  const active = rowsOf(answer, 'active');
  const days = daysOf(answer.today, answer.filters.days);
  const clients = ['mac', 'android', 'cli', 'mcp'].filter((c) =>
    active.some((row) => row['client'] === c),
  );
  const series = pivot(
    active,
    days,
    (row) => String(row['client']),
    'installs',
    clients,
    (k) => CLIENT_LABELS[k] ?? k,
    (_, i) => slot(i),
  );
  const versions = rowsOf(answer, 'versions');
  return [
    tiles([
      { label: 'Active Installs Today', value: totals.today ?? 0 },
      { label: 'Active Installs, Last 7 Days', value: totals.last7 ?? 0 },
      { label: 'Active Installs, Last 30 Days', value: totals.last30 ?? 0 },
    ]),
    card({
      id: 'weekly-active',
      title: 'Weekly Active Installs by Client',
      note: 'Each day: installs that did anything in the 7 days up to it.',
      chart: (width) =>
        lineChart({ categories: days, series, label: 'Weekly active installs by client' }, width),
      legend: series,
      legendShape: 'line',
      table: {
        columns: ['Day', ...series.map((s) => s.label)],
        rows: days.map((day, i) => [day, ...series.map((s) => s.values[i] ?? 0)]),
      },
      empty: active.length === 0,
    }),
    actorCard(answer, 'actor-split'),
    card({
      id: 'top-versions',
      title: 'Top Versions',
      note: 'Installs active in the period, by version and client.',
      chart: null,
      table: {
        columns: ['Version', 'Client', 'Installs'],
        rows: versions.map((row) => [
          String(row['version']),
          CLIENT_LABELS[String(row['client'])] ?? titled(String(row['client'])),
          Number(row['installs']),
        ]),
      },
      empty: versions.length === 0,
    }),
  ];
}
