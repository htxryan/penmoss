/** The dashboard's Health view. */
import { bars, lineChart, type Series } from '../charts';
import { CLIENT_LABELS, SYNC_LABELS, fullNumber, titled } from '../names';
import { slot, daysOf, distinct, card, tiles, type Answer, rowsOf } from '../cards';

export function health(answer: Answer): HTMLElement[] {
  const rows = rowsOf(answer, 'health');
  const days = daysOf(answer.today, answer.filters.days);
  const keys = ['accepted', 'dropped', 'written'];
  const labels: Record<string, string> = {
    accepted: 'Accepted',
    dropped: 'Dropped',
    written: 'Written',
  };
  const index = new Map(days.map((day, i) => [day, i]));
  const series: Series[] = keys.map((key, k) => {
    const values = days.map(() => 0);
    for (const row of rows) {
      const i = index.get(String(row['day']));
      if (i !== undefined) values[i] = Number(row[key] ?? 0);
    }
    return { key, label: labels[key] ?? key, color: slot(k), values };
  });
  const sum = (key: string) => rows.reduce((s, row) => s + Number(row[key] ?? 0), 0);
  const cap = Number(answer['writeCap']);
  const peak = Math.max(0, ...rows.map((row) => Number(row['written'] ?? 0)));
  const sync = rowsOf(answer, 'sync');
  const results = distinct(sync, 'result');
  return [
    tiles([
      { label: 'Batches', value: sum('batches') },
      { label: 'Events Accepted', value: sum('accepted') },
      { label: 'Events Dropped', value: sum('dropped') },
      { label: 'Forgets', value: sum('forgets') },
    ]),
    card({
      id: 'ingest',
      title: 'Events per Day',
      note: `Rows written on the busiest day: ${fullNumber(peak)} of the ${fullNumber(cap)} a day D1's free plan allows (${((100 * peak) / cap).toFixed(1)}%).`,
      chart: (width) =>
        lineChart(
          { categories: days, series, label: 'Events accepted, dropped and written per day' },
          width,
        ),
      legend: series,
      legendShape: 'line',
      table: {
        columns: ['Day', 'Batches', 'Accepted', 'Dropped', 'Written', 'Forgets'],
        rows: rows.map((row) => [
          String(row['day']),
          Number(row['batches']),
          Number(row['accepted']),
          Number(row['dropped']),
          Number(row['written']),
          Number(row['forgets']),
        ]),
      },
      empty: rows.length === 0,
    }),
    card({
      id: 'sync',
      title: 'Sync Passes',
      chart: (width) =>
        bars(
          {
            label: 'Sync passes by result',
            unit: 'passes',
            series: [{ key: 'passes', label: 'Passes', color: 'var(--s1)' }],
            rows: results.map((result) => ({
              label: SYNC_LABELS[result] ?? 'Other',
              parts: [
                sync
                  .filter((row) => row['result'] === result)
                  .reduce((s, row) => s + Number(row['passes']), 0),
              ],
            })),
          },
          width,
        ),
      table: {
        columns: ['Client', 'Result', 'Took', 'Passes', 'Installs'],
        rows: sync.map((row) => [
          CLIENT_LABELS[String(row['client'])] ?? '',
          SYNC_LABELS[String(row['result'])] ?? titled(String(row['result'])),
          String(row['took']),
          Number(row['passes']),
          Number(row['installs']),
        ]),
      },
      empty: sync.length === 0,
    }),
  ];
}
