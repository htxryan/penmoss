/**
 * The period of an open daily or weekly note (T19): PeriodNav above it, and the Time Machine's
 * link under a weekly note's title (PEN-21).
 */
import { readIdentity } from '@penmoss/sync-client/note';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { useEffect, useState } from 'react';

export type Period = { readonly kind: 'daily' | 'weekly'; readonly period: string } | null;

/** The period of an open daily or weekly note, read from its document (A16). */
export function usePeriod(replica: Yjs14Replica | null): Period {
  const [period, setPeriod] = useState<Period>(null);
  useEffect(() => {
    if (!replica) return;
    const read = () => {
      const { kind, period: value } = readIdentity(replica.doc);
      setPeriod((kind === 'daily' || kind === 'weekly') && value ? { kind, period: value } : null);
    };
    read();
    return replica.onUpdate(read);
  }, [replica]);
  return replica ? period : null;
}
