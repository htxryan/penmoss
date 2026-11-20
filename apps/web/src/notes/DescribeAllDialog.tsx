/**
 * Describe Notes Now (PEN-161): for a folder (and its subfolders), a whole notebook, or every
 * notebook (Settings → AI Descriptions → Describe All Notes), how many notes would be described,
 * then, once confirmed, describes them a few at a time with progress, and can be stopped. Turning
 * AI Descriptions on never describes every note at once: this does, when asked.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { useSource } from '../sources/hooks';
import { windowDescriber, type DescriberSource } from './describer';

/** Some of a notebook's notes, to describe. */
export interface DescribeGroup {
  readonly source: DescriberSource;
  readonly noteIds: readonly string[];
}

/** A folder's or a notebook's notes, in the notebook in context. */
export function DescribeAllDialog({
  name,
  noteIds,
  onClose,
}: {
  /** The folder's or notebook's name. */
  name: string;
  noteIds: readonly string[];
  onClose: () => void;
}) {
  const source = useSource();
  const groups = useMemo(() => (source ? [{ source, noteIds }] : []), [source, noteIds]);
  return <DescribeNotesDialog name={name} groups={source ? groups : null} onClose={onClose} />;
}

/**
 * The notes of several notebooks, one notebook after another (Describe All Notes). `groups` is
 * null while they can't be told yet.
 */
export function DescribeNotesDialog({
  name,
  groups,
  onClose,
}: {
  /** The folder's or notebook's name; none for every notebook's notes. */
  name?: string;
  groups: readonly DescribeGroup[] | null;
  onClose: () => void;
}) {
  const describer = windowDescriber();
  const [wanted, setWanted] = useState<readonly DescribeGroup[] | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!groups || !describer) return;
    let live = true;
    void (async () => {
      const out: DescribeGroup[] = [];
      for (const group of groups) {
        const ids: string[] = [];
        for (const id of group.noteIds) {
          if (await describer.wants(group.source, id).catch(() => false)) ids.push(id);
        }
        if (ids.length > 0) out.push({ source: group.source, noteIds: ids });
      }
      if (live) setWanted(out);
    })();
    return () => {
      live = false;
    };
  }, [groups, describer]);
  useEffect(() => () => stop.current?.abort(), []);
  const total = wanted?.reduce((sum, group) => sum + group.noteIds.length, 0) ?? null;
  // Stop closes the dialog, so a stopped batch is never shown running.
  const running = done !== null && total !== null && done < total;
  const finished = done !== null && total !== null && done >= total;
  const start = () => {
    if (!describer || !wanted) return;
    const controller = new AbortController();
    stop.current = controller;
    setDone(0);
    void (async () => {
      let before = 0;
      for (const group of wanted) {
        if (controller.signal.aborted) return;
        const at = before;
        before += await describer.batch(group.source, group.noteIds, false, {
          signal: controller.signal,
          onProgress: (count) => setDone(at + count),
        });
      }
      setDone((now) => now ?? 0);
    })();
  };
  return (
    <ConfirmDialog
      title={name === undefined ? 'Describe All Notes?' : `Describe Notes in “${name}”?`}
      testId="describe-all"
      onCancel={() => {
        stop.current?.abort();
        onClose();
      }}
      onSubmit={() => (finished ? onClose() : start())}
    >
      {total === null ? (
        <p>Counting the notes to describe…</p>
      ) : total === 0 ? (
        <p data-testid="describe-all-count">
          Every note here is described already, or AI Descriptions is off for it.
        </p>
      ) : (
        <>
          <p data-testid="describe-all-count">
            {total === 1
              ? '1 note has no description, or has changed since its description.'
              : `${total} notes have no description, or have changed since theirs.`}{' '}
            Each goes to your AI provider, two at a time.
          </p>
          {done !== null ? (
            <>
              <progress
                className="ai-progress"
                max={total}
                value={done}
                aria-label="Notes described"
              />
              <p className="muted" role="status" data-testid="describe-all-progress">
                {finished
                  ? `Described ${done} of ${total}.`
                  : `Describing ${done + 1} of ${total}…`}
              </p>
            </>
          ) : null}
        </>
      )}
      <div className="confirm-actions">
        {running ? (
          <button
            data-ui="dismiss"
            type="button"
            className="btn"
            data-event="describe-all.stop"
            onClick={() => {
              stop.current?.abort();
              onClose();
            }}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            data-ui="dismiss"
            data-event="describe-all.stop"
            onClick={onClose}
            autoFocus
          >
            {finished ? 'Close' : 'Cancel'}
          </button>
        )}
        {!finished && !running ? (
          <button
            type="submit"
            className="btn primary"
            data-ui="submit"
            data-event="describe-all.start"
            disabled={!total}
          >
            {total ? `Describe ${total === 1 ? '1 Note' : `${total} Notes`}` : 'Describe'}
          </button>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
