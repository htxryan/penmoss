/** The dashboard's First Run view. */
import { bars, funnel } from '../charts';
import { CLIENT_LABELS, FIRSTRUN_LABELS, STEP_RESULT_LABELS, titled } from '../names';
import { distinct, card, type Answer, rowsOf } from '../cards';

export function firstRun(answer: Answer): HTMLElement[] {
  const steps = rowsOf(answer, 'steps');
  const order = distinct(steps, 'step');
  const stepLabel = (step: unknown) => FIRSTRUN_LABELS[String(step)] ?? titled(String(step));
  const totals = order.map((step) => ({
    label: stepLabel(step),
    value: steps
      .filter((row) => row['step'] === step)
      .reduce((sum, row) => sum + Number(row['installs']), 0),
  }));
  const gaveUp = rowsOf(answer, 'gaveUp');
  const capped = Number(answer['days']) < answer.filters.days;
  return [
    card({
      id: 'funnel',
      title: 'First Run Funnel',
      note: `Installs reaching each step${capped ? ', over the last 90 days' : ''}.`,
      chart: (width) => funnel({ label: 'First run funnel', steps: totals }, width),
      table: {
        columns: ['Step', 'Client', 'Installs', 'Finished the Step'],
        rows: steps.map((row) => [
          stepLabel(row['step']),
          CLIENT_LABELS[String(row['client'])] ?? '',
          Number(row['installs']),
          Number(row['done']),
        ]),
      },
      empty: steps.length === 0,
    }),
    card({
      id: 'gave-up',
      title: 'Where Installs Gave Up',
      note: 'The last step reached by installs that never finished the first run.',
      chart: (width) =>
        bars(
          {
            label: 'Where installs gave up',
            unit: 'installs',
            series: [{ key: 'installs', label: 'Installs', color: 'var(--s2)' }],
            rows: gaveUp.map((row) => ({
              label: [
                stepLabel(row['step']),
                STEP_RESULT_LABELS[String(row['result'])] ?? '',
                row['error'] ? titled(String(row['error'])) : '',
              ]
                .filter(Boolean)
                .join(' · '),
              parts: [Number(row['installs'])],
            })),
          },
          width,
        ),
      table: {
        columns: ['Step', 'Client', 'Result', 'Error', 'Installs'],
        rows: gaveUp.map((row) => [
          stepLabel(row['step']),
          CLIENT_LABELS[String(row['client'])] ?? '',
          STEP_RESULT_LABELS[String(row['result'])] ?? '',
          row['error'] ? titled(String(row['error'])) : '',
          Number(row['installs']),
        ]),
      },
      empty: gaveUp.length === 0,
    }),
  ];
}
