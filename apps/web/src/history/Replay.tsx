import { Icon } from '@penmoss/ui/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Authors, DiffLines } from './parts';
import type { HistoryDetail, HistorySource, HistoryVersion } from './source';

/** How fast Replay plays: one version a second at 1×. */
const REPLAY_SPEEDS = [1, 2, 4] as const;
type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
/** A version shown at 1×, in ms. */
const REPLAY_STEP_MS = 1000;

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * Replay (PEN-21): a note's versions played forward, oldest first, one a second (2× and 4×
 * faster), each as its whole text with what that version changed marked, and who made it. Pause,
 * a step either way, and a version's place; the panel's list comes back with Close.
 */
export function Replay({
  source,
  versions,
  onClose,
}: {
  source: HistorySource;
  /** Newest first, as the panel lists them. */
  versions: readonly HistoryVersion[];
  onClose: () => void;
}) {
  const ordered = useMemo(() => [...versions].reverse(), [versions]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [details, setDetails] = useState<ReadonlyMap<number, HistoryDetail | null>>(new Map());
  const asked = useRef(new Set<number>());
  const version = ordered[index] ?? null;
  const detail = version ? details.get(version.id) : undefined;
  const last = index >= ordered.length - 1;
  // Played to the end, it stops there.
  const running = playing && !last;

  // The version shown and the next one are read ahead, each once.
  useEffect(() => {
    for (const each of [ordered[index], ordered[index + 1]]) {
      if (!each || asked.current.has(each.id)) continue;
      asked.current.add(each.id);
      void source
        .detail(each.id)
        .catch(() => null)
        .then((read) => setDetails((before) => new Map(before).set(each.id, read)));
    }
  }, [index, ordered, source]);

  // Playing: the next version once this one is shown and has had its time.
  useEffect(() => {
    if (!running || detail === undefined) return;
    const timer = setTimeout(() => setIndex((at) => at + 1), REPLAY_STEP_MS / speed);
    return () => clearTimeout(timer);
  }, [running, detail, speed]);

  const step = (by: number) => {
    setPlaying(false);
    setIndex((at) => Math.min(ordered.length - 1, Math.max(0, at + by)));
  };

  return (
    <section className="history-replay" aria-label="Replay" data-testid="history-replay">
      <div className="replay-controls" role="toolbar" aria-label="Replay Controls">
        <button
          type="button"
          className="icon-btn"
          data-ui="item"
          aria-label="Previous Version"
          data-tip="Previous Version"
          disabled={index === 0}
          onClick={() => step(-1)}
        >
          <Icon name="chevL" />
        </button>
        <button
          type="button"
          className="icon-btn replay-play"
          data-ui="item"
          aria-label={running ? 'Pause' : 'Play'}
          data-tip={running ? 'Pause' : 'Play'}
          data-testid="replay-play"
          onClick={() => {
            if (running) {
              setPlaying(false);
              return;
            }
            // Played to the end, Play starts again from the first.
            if (last) setIndex(0);
            setPlaying(true);
          }}
        >
          <Icon name={running ? 'pause' : 'play'} />
        </button>
        <button
          type="button"
          className="icon-btn"
          data-ui="item"
          aria-label="Next Version"
          data-tip="Next Version"
          disabled={last}
          onClick={() => step(1)}
        >
          <Icon name="chevR" />
        </button>
        <div className="replay-speeds" role="group" aria-label="Speed">
          {REPLAY_SPEEDS.map((each) => (
            <button
              key={each}
              type="button"
              className="btn quiet"
              data-ui="option"
              aria-pressed={speed === each}
              onClick={() => setSpeed(each)}
            >
              {each}×
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn quiet replay-close"
          data-ui="dismiss"
          onClick={onClose}
        >
          Close Replay
        </button>
      </div>
      {version ? (
        <>
          <p
            className="replay-place"
            role="status"
            data-testid="replay-place"
            data-version={version.id}
          >
            <span className="replay-count">
              Version {index + 1} of {ordered.length}
            </span>
            <span className="history-time">{when(version.createdAt)}</span>
            <Authors authors={version.authors} />
          </p>
          <input
            className="replay-scrubber"
            type="range"
            min={0}
            max={Math.max(0, ordered.length - 1)}
            value={index}
            aria-label="Version"
            aria-valuetext={`Version ${index + 1} of ${ordered.length}`}
            onChange={(event) => {
              setPlaying(false);
              setIndex(Number(event.currentTarget.value));
            }}
          />
          <div className="history-diff replay-text" data-testid="replay-text">
            {detail === undefined ? (
              <p className="muted loading">
                <span className="spinner" aria-hidden="true" />
                Reading this version…
              </p>
            ) : detail === null ? (
              <p className="muted">This version could not be read.</p>
            ) : (
              <DiffLines diff={detail.diff} whole />
            )}
          </div>
        </>
      ) : (
        <p className="muted">No versions to replay yet.</p>
      )}
    </section>
  );
}
