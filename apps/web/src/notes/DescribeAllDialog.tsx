/**
 * Describe Notes Now (PEN-161): for a folder (and its subfolders) or a whole notebook, how many
 * notes would be described, then, once confirmed, describes them a few at a time with progress,
 * and can be stopped. Turning AI Descriptions on never describes every note at once: this does,
 * when asked.
 */
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { useSource } from '../sources/hooks';
import { windowDescriber } from './describer';

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
  const describer = windowDescriber();
  const [wanted, setWanted] = useState<readonly string[] | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!source || !describer) return;
    let live = true;
    void (async () => {
      const out: string[] = [];
      for (const id of noteIds) {
        if (await describer.wants(source, id).catch(() => false)) out.push(id);
      }
      if (live) setWanted(out);
    })();
    return () => {
      live = false;
    };
  }, [source, describer, noteIds]);
  useEffect(() => () => stop.current?.abort(), []);
  // Stop closes the dialog, so a stopped batch is never shown running.
  const running = done !== null && wanted !== null && done < wanted.length;
  const finished = done !== null && wanted !== null && done >= wanted.length;
  const start = () => {
    if (!source || !describer || !wanted) return;
    const controller = new AbortController();
    stop.current = controller;
    setDone(0);
    void describer
      .batch(source, wanted, false, { signal: controller.signal, onProgress: setDone })
      .then(() => setDone((now) => now ?? 0));
  };
  return (
    <ConfirmDialog
      title={`Describe Notes in “${name}”?`}
      testId="describe-all"
      onCancel={() => {
        stop.current?.abort();
        onClose();
      }}
      onSubmit={() => (finished ? onClose() : start())}
    >
      {wanted === null ? (
        <p>Counting the notes to describe…</p>
      ) : wanted.length === 0 ? (
        <p data-testid="describe-all-count">
          Every note here is described already, or AI Descriptions is off for it.
        </p>
      ) : (
        <>
          <p data-testid="describe-all-count">
            {wanted.length === 1
              ? '1 note has no description, or has changed since its description.'
              : `${wanted.length} notes have no description, or have changed since theirs.`}{' '}
            Each goes to your AI provider, two at a time.
          </p>
          {done !== null ? (
            <>
              <progress
                className="ai-progress"
                max={wanted.length}
                value={done}
                aria-label="Notes described"
              />
              <p className="muted" role="status" data-testid="describe-all-progress">
                {finished
                  ? `Described ${done} of ${wanted.length}.`
                  : `Describing ${done + 1} of ${wanted.length}…`}
              </p>
            </>
          ) : null}
        </>
      )}
      <div className="confirm-actions">
        {running ? (
          <button
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
            disabled={!wanted || wanted.length === 0}
          >
            {wanted && wanted.length > 0
              ? `Describe ${wanted.length === 1 ? '1 Note' : `${wanted.length} Notes`}`
              : 'Describe'}
          </button>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
