/** The dashboard's Commands & Shortcuts view. */
import { bars, formatNumber, type BarRow, type BarColumn } from '../charts';
import { SOURCE_LABELS, commandName, displayName, eventName, titled } from '../names';
import { type Row, slot, distinct, card, type Answer, rowsOf } from '../cards';

export function commands(answer: Answer): HTMLElement[] {
  const rows = rowsOf(answer, 'commands');
  const names = distinct(rows, 'name');
  const sources = ['key', 'palette', 'button', 'menu', 'tray', 'hotkey', 'editor', 'other'];
  const sourceOf = (row: Row) =>
    sources.includes(String(row['source'])) ? String(row['source']) : 'other';
  const used = sources.filter((s) => rows.some((row) => sourceOf(row) === s));
  const legend = used.map((s) => ({
    key: s,
    label: SOURCE_LABELS[s] ?? s,
    color: slot(sources.indexOf(s)),
  }));
  const top = names.map((name) => {
    const own = rows.filter((row) => row['name'] === name);
    const parts = used.map((s) =>
      own.filter((row) => sourceOf(row) === s).reduce((sum, row) => sum + Number(row['runs']), 0),
    );
    return {
      name,
      parts,
      runs: parts.reduce((sum, n) => sum + n, 0),
      installs: Number(own[0]?.['installs'] ?? 0),
    };
  });
  const commandRows: BarRow[] = top.map(({ name, parts }) => ({
    label: displayName('command', name),
    id: name,
    parts,
  }));
  const installsColumn: BarColumn = {
    label: 'Installs',
    values: top.map(({ installs }) => formatNumber(installs)),
  };
  const shortcuts = rowsOf(answer, 'shortcuts').slice(0, 25);
  const unused = rowsOf(answer, 'unused');
  const chips = document.createElement('ul');
  chips.className = 'chips';
  chips.setAttribute('aria-label', 'Never Used Names');
  for (const row of unused) {
    const chip = document.createElement('li');
    chip.className = 'chip';
    const event = eventName(`${String(row['kind'])}:${String(row['name'])}`);
    chip.textContent = event.title;
    chip.title = event.id;
    chips.append(chip);
  }
  return [
    card({
      id: 'top-commands',
      title: 'Top 25 Commands',
      note: 'Runs, split by where each was run from, and how many installs ran it.',
      chart: (width) =>
        bars(
          {
            label: 'Top 25 commands by runs',
            unit: 'runs',
            series: legend,
            rows: commandRows,
            columns: [installsColumn],
            totalLabel: 'Runs',
          },
          width,
        ),
      legend,
      table: {
        columns: ['Command', 'Runs', 'Installs', ...legend.map((s) => s.label)],
        rows: top.map(({ name, runs, installs, parts }) => [
          commandName(name),
          runs,
          installs,
          ...parts,
        ]),
      },
      empty: rows.length === 0,
    }),
    card({
      id: 'shortcuts',
      title: 'Shortcuts',
      note: "Each combination's share of its command's runs, its default, and how many installs rebound it.",
      chart: (width) =>
        bars(
          {
            label: 'Key share of each command',
            unit: 'of the runs by this key',
            suffix: '%',
            series: [{ key: 'share', label: 'Key Share', color: 'var(--s1)' }],
            rows: shortcuts.map((row) => ({
              label: `${displayName('command', String(row['name']))} · ${String(row['keys'])}`,
              id: String(row['name']),
              parts: [Number(row['key_share'])],
              note: `${formatNumber(Number(row['key_runs']))} runs`,
            })),
            columns: [
              {
                label: 'Default',
                width: 104,
                values: shortcuts.map((row) => String(row['default_keys'] || 'None')),
              },
              {
                label: 'Rebound',
                values: shortcuts.map((row) => formatNumber(Number(row['rebound_installs']))),
              },
            ],
            totalLabel: 'Key Share',
          },
          width,
        ),
      table: {
        columns: [
          'Command',
          'Keys',
          'Default Keys',
          'Key Runs',
          'All Runs',
          'Key Share %',
          'Installs',
          'Rebound',
        ],
        rows: shortcuts.map((row) => [
          commandName(String(row['name'])),
          String(row['keys']),
          String(row['default_keys'] || 'None'),
          Number(row['key_runs']),
          Number(row['all_runs']),
          Number(row['key_share']),
          Number(row['installs']),
          Number(row['rebound_installs']),
        ]),
      },
      empty: shortcuts.length === 0,
    }),
    card({
      id: 'never-used',
      title: 'Never Used',
      count: unused.length,
      note: 'Catalogued commands, controls, screens, dialogs, menus, settings, CLI commands and MCP tools nobody used in this period.',
      chart: null,
      custom: chips,
      table: {
        columns: ['Kind', 'Name'],
        rows: unused.map((row) => [
          titled(String(row['kind'])),
          eventName(`${String(row['kind'])}:${String(row['name'])}`),
        ]),
      },
      empty: unused.length === 0,
    }),
  ];
}
