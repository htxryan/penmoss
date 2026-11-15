import { Icon } from '@penmoss/ui/icons';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { usePeriod } from '../journal/period';
import { linkHandler } from '../router';
import { useSource } from '../sources/hooks';
import { timeMachinePath } from './path';

/**
 * Under a weekly note's title (PEN-21): a small link to What Changed in the Time Machine for
 * that week, Monday to Sunday in the notebook's time zone. A link in the page, never text in
 * the note.
 */
export function WeekChangesLink({ replica }: { replica: Yjs14Replica | null }) {
  const period = usePeriod(replica);
  const source = useSource();
  if (period?.kind !== 'weekly' || source?.kind !== 'git') return null;
  const href = timeMachinePath(source.id, { tab: 'changes', week: period.period });
  return (
    <p className="week-changes">
      <a href={href} data-ui="item" data-testid="week-changes" onClick={linkHandler(href)}>
        <Icon name="history" size={14} />
        What changed this week
      </a>
    </p>
  );
}
