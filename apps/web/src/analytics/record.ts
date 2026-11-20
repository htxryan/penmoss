/**
 * The page's side of usage analytics (PEN-137): `record(kind, name, props)` from anywhere in the
 * page. Events go to the Mac app's main process in small batches (`analytics.record` over IPC),
 * which stamps the session, `seq`, the client fields and the state, and stores them; main checks
 * each against the catalogue again. Outside the Mac app (the web build, the web suite) they go to
 * a memory sink the specs read (`window.__penmossAnalytics`), and never leave the page.
 *
 * Recording never throws, never waits and never slows a click: it pushes to an array and
 * flushes on a timer.
 */
import { eventProblem, sizeClassOf, type EventKind, type Props } from '@penmoss/core/analytics';
import { desktop } from '../desktop/bridge';
import type { PageEvent } from '../desktop/bridge';

declare global {
  interface Window {
    /** The web build's memory sink (and what the web suite reads): the page's last events. */
    __penmossAnalytics?: PageEvent[];
  }
}

const FLUSH_MS = 250;
const MEMORY_CAP = 2000;

let queue: PageEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Fields the page's own check fills in; main replaces them with the real ones. */
const CHECK_FIELDS = {
  session: '0000000000000000',
  seq: 0,
  client: 'mac',
  actor: 'person',
  version: '0.0.0',
  channel: 'dev',
  os: 'macos',
  osVersion: '0',
} as const;

function flush(): void {
  timer = null;
  const events = queue;
  queue = [];
  if (events.length === 0) return;
  try {
    const analytics = desktop()?.analytics;
    if (analytics) {
      analytics.record(events);
      return;
    }
    const memory = (window.__penmossAnalytics ??= []);
    memory.push(...events);
    if (memory.length > MEMORY_CAP) memory.splice(0, memory.length - MEMORY_CAP);
  } catch {
    // Recording never breaks the page.
  }
}

/** Flushes now (before the page unloads, and in tests). */
export function flushRecorded(): void {
  if (timer) clearTimeout(timer);
  flush();
}

/**
 * Records one interaction by name. An event the catalogue doesn't know, or with a prop it
 * doesn't allow, is dropped here (and warned about in development), so it never reaches main.
 */
export function record(kind: EventKind, name: string, props: Props = {}): void {
  try {
    const clean = Object.fromEntries(
      Object.entries(props).filter(([, value]) => value !== undefined),
    ) as Props;
    const at = Date.now();
    const problem = eventProblem({ ...CHECK_FIELDS, at, kind, name, props: clean });
    if (problem) {
      if (import.meta.env.DEV) console.warn(`analytics: dropped ${kind} ${name}: ${problem}`);
      return;
    }
    queue.push({ kind, name, props: clean, at, sizeClass: sizeClassOf(window.innerWidth) });
    if (queue.length >= 50) flushRecorded();
    else timer ??= setTimeout(flush, FLUSH_MS);
  } catch {
    // Recording never breaks the page.
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushRecorded);
}
