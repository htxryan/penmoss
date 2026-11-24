/** The dashboard's Agents view. */
import { bars, formatNumber, type BarRow } from '../charts';
import { RESULTS, agentLabel, displayName } from '../names';
import { type Row, slot, distinct, card, type Answer, rowsOf, actorCard } from '../cards';

export function agents(answer: Answer): HTMLElement[] {
  const rows = rowsOf(answer, 'agents');
  const byCalls = distinct(rows, 'agent')
    .map((agent) => ({
      agent,
      calls: rows
        .filter((row) => row['agent'] === agent)
        .reduce((s, row) => s + Number(row['calls']), 0),
    }))
    .sort((a, b) => b.calls - a.calls);
  // Eight colours: the rest of the agents share Other.
  const shown = byCalls.slice(0, byCalls.length > 8 ? 7 : 8).map((a) => a.agent);
  const agentOf = (row: Row) =>
    shown.includes(String(row['agent'])) ? String(row['agent']) : 'other';
  const keys = [...shown, ...(byCalls.length > shown.length ? ['other'] : [])];
  const legend = keys.map((k, i) => ({
    key: k,
    label: k === 'other' && !shown.includes('other') ? 'Others' : agentLabel(k),
    color: k === 'other' ? 'var(--other)' : slot(i),
  }));
  const kindLabel = (kind: unknown) => (kind === 'tool' ? 'MCP' : 'CLI');
  const names = distinct(rows, 'name').map((name) => ({
    name,
    kind: String(rows.find((row) => row['name'] === name)?.['kind']),
  }));
  const nameRows: BarRow[] = names.map(({ name, kind }) => ({
    label: `${kindLabel(kind)} · ${displayName(kind, name)}`,
    id: name,
    parts: keys.map((k) =>
      rows
        .filter((row) => row['name'] === name && agentOf(row) === k)
        .reduce((s, row) => s + Number(row['calls']), 0),
    ),
  }));
  // Each command or tool, by agent client: the share of its calls that ended in each result.
  const share = (part: number, calls: number) =>
    calls ? Math.round((1000 * part) / calls) / 10 : 0;
  const rateRows = rows.map((row) => {
    const calls = Number(row['calls']);
    return {
      label: `${kindLabel(row['kind'])} · ${displayName(String(row['kind']), String(row['name']))} · ${agentLabel(String(row['agent']))}`,
      id: String(row['name']),
      calls,
      counts: RESULTS.map((result) => Number(row[result.key] ?? 0)),
    };
  });
  return [
    actorCard(answer, 'agents-actors'),
    card({
      id: 'agent-calls',
      title: 'CLI Commands and MCP Tools by Agent',
      note: "Calls, split by the agent client (an MCP tool's), or who ran the CLI.",
      chart: (width) =>
        bars(
          {
            label: 'CLI commands and MCP tools by agent',
            unit: 'calls',
            series: legend,
            rows: nameRows,
          },
          width,
        ),
      legend,
      table: {
        columns: ['Kind', 'Name', 'Agent', 'Calls', 'Installs'],
        rows: rows.map((row) => [
          kindLabel(row['kind']),
          { title: displayName(String(row['kind']), String(row['name'])), id: String(row['name']) },
          agentLabel(String(row['agent'])),
          Number(row['calls']),
          Number(row['installs']),
        ]),
      },
      empty: rows.length === 0,
    }),
    card({
      id: 'result-rates',
      title: 'Result Rates',
      note: 'How each CLI command and MCP tool ended, by agent client: its share of the calls.',
      chart: (width) =>
        bars(
          {
            label: 'Result rates by agent client',
            unit: 'of the calls',
            suffix: '%',
            series: RESULTS,
            rows: rateRows.map((row) => ({
              label: row.label,
              id: row.id,
              parts: row.counts.map((count) => share(count, row.calls)),
            })),
            columns: [{ label: 'Calls', values: rateRows.map((row) => formatNumber(row.calls)) }],
            totalLabel: 'Results',
            showTotal: false,
          },
          width,
        ),
      legend: RESULTS,
      table: {
        columns: ['Name', 'Calls', ...RESULTS.map((result) => `${result.label} %`)],
        rows: rateRows.map((row) => [
          { title: row.label, id: row.id },
          row.calls,
          ...row.counts.map((count) => share(count, row.calls)),
        ]),
      },
      empty: rows.length === 0,
    }),
  ];
}
