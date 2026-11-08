// Cold-open timing, long tasks, long animation frames and a scroll frame sampler.
// All times are milliseconds relative to navigation start (performance.now()).

const MAX_ENTRIES = 500;

export interface Timings {
  /** First line of the bundle evaluated. */
  scriptStart: number;
  /** TipTap `create` event fired (schema built, note parsed, view mounted). */
  editorReady: number | null;
  /** Second animation frame after editorReady: the note has been painted. */
  notePainted: number | null;
  firstPaint: number | null;
  firstContentfulPaint: number | null;
  domContentLoaded: number | null;
}

interface TimedEntry {
  start: number;
  duration: number;
  blocking?: number;
}

interface ScrollSession {
  frames: number;
  durationMs: number;
  avgFps: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  /** Frame intervals over 16.7 ms: frames that missed a 60 fps deadline. */
  over60fpsBudget: number;
}

const round = (n: number) => Math.round(n * 10) / 10;

export const timings: Timings = {
  scriptStart: round(performance.now()),
  editorReady: null,
  notePainted: null,
  firstPaint: null,
  firstContentfulPaint: null,
  domContentLoaded: null,
};

const longTasks: TimedEntry[] = [];
const longFrames: TimedEntry[] = [];
const scrollSessions: ScrollSession[] = [];

function push<T>(list: T[], item: T) {
  list.push(item);
  if (list.length > MAX_ENTRIES) list.shift();
}

function observe(type: string, callback: (entry: PerformanceEntry) => void) {
  try {
    new PerformanceObserver((list) => list.getEntries().forEach(callback)).observe({
      type,
      buffered: true,
    });
  } catch {
    // Entry type not supported by this engine; leave the list empty.
  }
}

export function startMetrics(): void {
  observe('paint', (entry) => {
    if (entry.name === 'first-paint') timings.firstPaint = round(entry.startTime);
    if (entry.name === 'first-contentful-paint')
      timings.firstContentfulPaint = round(entry.startTime);
  });
  observe('longtask', (entry) =>
    push(longTasks, { start: round(entry.startTime), duration: round(entry.duration) }),
  );
  observe('long-animation-frame', (entry) =>
    push(longFrames, {
      start: round(entry.startTime),
      duration: round(entry.duration),
      blocking: round(
        (entry as PerformanceEntry & { blockingDuration?: number }).blockingDuration ?? 0,
      ),
    }),
  );
  const nav = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  if (nav) timings.domContentLoaded = round(nav.domContentLoadedEventEnd) || null;
  document.addEventListener('DOMContentLoaded', () => {
    timings.domContentLoaded = round(performance.now());
  });
  startScrollSampler();
}

/** Call from the editor's `create` event; resolves once the note has been painted. */
export function markEditorReady(): Promise<void> {
  timings.editorReady = round(performance.now());
  return new Promise((resolve) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        timings.notePainted = round(performance.now());
        resolve();
      }),
    );
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

// Records animation-frame intervals while the page scrolls, as one session per
// gesture (a session ends 300 ms after the last scroll event).
function startScrollSampler() {
  let intervals: number[] = [];
  let last = 0;
  let lastScroll = 0;
  let running = false;

  const frame = (now: number) => {
    if (last) intervals.push(now - last);
    last = now;
    if (now - lastScroll < 300) {
      requestAnimationFrame(frame);
      return;
    }
    running = false;
    if (intervals.length >= 10) {
      const sorted = [...intervals].sort((a, b) => a - b);
      const total = intervals.reduce((a, b) => a + b, 0);
      push(scrollSessions, {
        frames: intervals.length,
        durationMs: round(total),
        avgFps: round((intervals.length * 1000) / total),
        p50: round(percentile(sorted, 50)),
        p95: round(percentile(sorted, 95)),
        p99: round(percentile(sorted, 99)),
        worst: round(sorted[sorted.length - 1]!),
        over60fpsBudget: intervals.filter((i) => i > 1000 / 60 + 1).length,
      });
    }
    intervals = [];
    last = 0;
  };

  window.addEventListener(
    'scroll',
    () => {
      lastScroll = performance.now();
      if (!running) {
        running = true;
        requestAnimationFrame(frame);
      }
    },
    { passive: true, capture: true },
  );
}

export function metricsSnapshot() {
  const totalLongTaskMs = longTasks.reduce((sum, t) => sum + t.duration, 0);
  return {
    timings: { ...timings },
    longTasks: {
      count: longTasks.length,
      totalMs: round(totalLongTaskMs),
      worstMs: longTasks.reduce((max, t) => Math.max(max, t.duration), 0),
      entries: longTasks.slice(-50),
    },
    longAnimationFrames: {
      count: longFrames.length,
      worstMs: longFrames.reduce((max, t) => Math.max(max, t.duration), 0),
      entries: longFrames.slice(-50),
    },
    scroll: scrollSessions.slice(-20),
  };
}
