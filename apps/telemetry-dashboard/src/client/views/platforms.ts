/** The dashboard's Platforms view. */
import { bars, stackedArea } from '../charts';
import { CLIENT_LABELS, osName, titled } from '../names';
import { type Row, slot, daysOf, pivot, distinct, card, type Answer, rowsOf } from '../cards';

export function platforms(answer: Answer): HTMLElement[] {
  const platformRows = rowsOf(answer, 'platforms');
  const adoption = rowsOf(answer, 'adoption');
  const days = daysOf(answer.today, answer.filters.days);
  const versions = distinct(adoption, 'version').sort((a, b) =>
    a === 'Other' ? 1 : b === 'Other' ? -1 : b.localeCompare(a, 'en', { numeric: true }),
  );
  const series = pivot(
    adoption,
    days,
    (row) => String(row['version']),
    'installs',
    versions,
    (k) => k,
    (k, i) => (k === 'Other' ? 'var(--other)' : slot(i)),
  );
  const sizes = rowsOf(answer, 'sizes');
  const sizeKeys = ['compact', 'medium', 'expanded', 'unknown'].filter((k) =>
    sizes.some((row) => row['size_class'] === k),
  );
  const sizeSeries = sizeKeys.map((k, i) => ({
    key: k,
    label: k[0]!.toUpperCase() + k.slice(1),
    color: slot(i),
  }));
  const sizeClients = distinct(sizes, 'client');
  // Main windows' sizes as recorded, to 10 px or dp (PEN-174); Other has no width or height.
  const windowSizes = rowsOf(answer, 'windowSizes');
  const sizeOf = (row: Row) =>
    row['width'] === null || row['height'] === null
      ? 'Other'
      : `${String(row['width'])} × ${String(row['height'])}`;
  return [
    card({
      id: 'os-versions',
      title: 'Clients and OS Versions',
      chart: (width) =>
        bars(
          {
            label: 'Installs by client and OS version',
            unit: 'installs',
            series: [{ key: 'installs', label: 'Installs', color: 'var(--s1)' }],
            rows: platformRows.map((row) => ({
              label: `${CLIENT_LABELS[String(row['client'])] ?? ''} · ${osName(String(row['os']))} ${String(row['os_version'])}`,
              parts: [Number(row['installs'])],
            })),
          },
          width,
        ),
      table: {
        columns: ['Client', 'OS', 'OS Version', 'Installs'],
        rows: platformRows.map((row) => [
          CLIENT_LABELS[String(row['client'])] ?? '',
          osName(String(row['os'])),
          String(row['os_version']),
          Number(row['installs']),
        ]),
      },
      empty: platformRows.length === 0,
    }),
    card({
      id: 'adoption',
      title: 'Version Adoption',
      note: 'Installs active each day by version: the 6 with most installs, then Other.',
      chart: (width) => stackedArea({ categories: days, series, label: 'Version adoption' }, width),
      legend: series,
      table: {
        columns: ['Day', ...series.map((s) => s.label)],
        rows: days.map((day, i) => [day, ...series.map((s) => s.values[i] ?? 0)]),
      },
      empty: adoption.length === 0,
    }),
    card({
      id: 'size-classes',
      title: 'Window Size Classes',
      chart: (width) =>
        bars(
          {
            label: 'Installs by window size class',
            unit: 'installs',
            series: sizeSeries,
            rows: sizeClients.map((client) => ({
              label: CLIENT_LABELS[client] ?? client,
              parts: sizeKeys.map((k) =>
                Number(
                  sizes.find((row) => row['client'] === client && row['size_class'] === k)?.[
                    'installs'
                  ] ?? 0,
                ),
              ),
            })),
          },
          width,
        ),
      legend: sizeSeries,
      table: {
        columns: ['Client', 'Size Class', 'Installs'],
        rows: sizes.map((row) => [
          CLIENT_LABELS[String(row['client'])] ?? '',
          titled(String(row['size_class'])),
          Number(row['installs']),
        ]),
      },
      empty: sizes.length === 0,
    }),
    card({
      id: 'window-sizes',
      title: 'Common Window Sizes',
      note: 'Installs by main window size: the 10 most common per client, then Other.',
      chart: (width) =>
        bars(
          {
            label: 'Installs by main window size',
            unit: 'installs',
            series: [{ key: 'installs', label: 'Installs', color: 'var(--s1)' }],
            rows: windowSizes.map((row) => ({
              label: `${CLIENT_LABELS[String(row['client'])] ?? ''} · ${sizeOf(row)}`,
              parts: [Number(row['installs'])],
            })),
          },
          width,
        ),
      table: {
        columns: ['Client', 'Window Size', 'Installs'],
        rows: windowSizes.map((row) => [
          CLIENT_LABELS[String(row['client'])] ?? '',
          sizeOf(row),
          Number(row['installs']),
        ]),
      },
      empty: windowSizes.length === 0,
    }),
  ];
}
