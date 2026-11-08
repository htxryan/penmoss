import { plainLabel, type DeletedBy } from './deleted-by';

/** An agent with ✦ (as in History), or a device, that moved a note or folder to Trash (T42, A574). */
export function DeletedByChip({ by }: { by: DeletedBy }) {
  return (
    <span className="trash-by" data-kind={by.kind} data-testid="trash-by">
      {plainLabel(by.label)}
      {by.kind === 'agent' ? (
        <>
          <span className="trash-agent" aria-hidden="true">
            ✦
          </span>
          <span className="sr-only"> (agent)</span>
        </>
      ) : null}
    </span>
  );
}
