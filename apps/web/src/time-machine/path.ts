/**
 * The Time Machine's address (PEN-21): `/time-machine`, with the notebook (`source`), the tab
 * (`tab=changes` for What Changed) and, for What Changed, an ISO week (`week=2026-W45`).
 */
export type TimeMachineTab = 'then' | 'changes';

export const TIME_MACHINE_PATH = '/time-machine';

export function timeMachinePath(
  sourceId: string | null,
  options: { readonly tab?: TimeMachineTab; readonly week?: string | null } = {},
): string {
  const query = new URLSearchParams();
  if (sourceId) query.set('source', sourceId);
  if (options.tab === 'changes') query.set('tab', 'changes');
  if (options.tab === 'changes' && options.week) query.set('week', options.week);
  const text = query.toString();
  return text ? `${TIME_MACHINE_PATH}?${text}` : TIME_MACHINE_PATH;
}
