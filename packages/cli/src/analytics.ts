/**
 * What the CLI and its MCP server record for usage analytics (PEN-137, CLI and MCP server): one
 * `cli` event per run, at exit, and one `tool` event per MCP tool call. Each goes into the record
 * this machine shares with the Mac app (`~/.penmoss/analytics/events.db`), in the state the
 * answer in `~/.penmoss/analytics.json` gives it then; DO_NOT_TRACK or PENMOSS_ANALYTICS=off keeps
 * this process's events on the machine. Only the app sends, so nothing here waits on the network,
 * and a record that cannot be written (no `node:sqlite`, a locked or read-only home) is skipped
 * without a word: recording never changes what a command prints or its exit code.
 *
 * A name is a command's or tool's; a prop is a flag's name (never its value), an exit code's
 * name, a duration bucket, a terminal flag, an agent from a fixed list or a result.
 */
import {
  cliActor,
  durationBucket,
  envOptsOut,
  limitsOf,
  Recorder,
  stateFor,
  type Actor,
  type AnalyticsEvent,
  type AnalyticsClient,
} from '@penmoss/core/analytics';
import type { AnalyticsStore } from '@penmoss/core/analytics/node';
import type { ToolCallRecord } from '@penmoss/git-notebook/local';
import { EXIT } from './errors';
import type { AnalyticsIo, Io } from './io';

/** What a run did, as `run` learns it: its command (null for none known) and its flags' names. */
export interface RunSeen {
  command: string | null;
  flags: readonly string[];
}

const EXIT_NAMES = new Map<number, string>(
  Object.entries(EXIT).map(([name, code]) => [code, name] as const),
);

/** An exit code's name ("OK", "USAGE"); anything else is ERROR. */
export function exitName(code: number): string {
  return EXIT_NAMES.get(code) ?? 'ERROR';
}

function recorder(
  analytics: AnalyticsIo,
  client: AnalyticsClient,
  actor: Actor,
  sink: (event: AnalyticsEvent) => void,
): Recorder {
  return new Recorder({
    fields: () => ({ client, actor, ...analytics.fields }),
    sink,
    now: () => analytics.now(),
  });
}

/** Writes events into the record in the state the answer gives them now, then keeps the limits. */
function write(
  analytics: AnalyticsIo,
  env: Io['env'],
  events: readonly AnalyticsEvent[],
  record: AnalyticsStore,
): void {
  const consent = analytics.readConsent();
  const state = stateFor(consent.consent, envOptsOut(env));
  record.insert(events.map((event) => ({ event, state })));
  record.pruneNow(limitsOf(consent), analytics.now());
}

/**
 * Records a run's `cli` event at exit (one transaction, then the limits kept). Never throws and
 * never waits: the store is SQLite on this machine.
 */
export function recordRun(io: Io, seen: RunSeen, code: number, started: number): void {
  const analytics = io.analytics;
  if (!analytics || seen.command === null) return;
  try {
    const tty = io.stdout.isTTY;
    // The MCP server is always an agent's (N5).
    const actor = seen.command === 'mcp' ? 'agent' : cliActor(io.env, tty);
    const events: AnalyticsEvent[] = [];
    recorder(analytics, 'cli', actor, (event) => events.push(event)).record('cli', seen.command, {
      flags: [...new Set(seen.flags)].sort().slice(0, 16),
      exit: exitName(code),
      took: durationBucket(analytics.now() - started),
      tty,
    });
    if (events.length === 0) return;
    const record = analytics.openStore();
    try {
      write(analytics, io.env, events, record);
    } finally {
      record.close();
    }
  } catch {
    // No record here (no node:sqlite, a locked or read-only home): the command is unchanged.
  }
}

/** How often the MCP server writes what it has recorded. */
export const TOOL_FLUSH_MS = 1000;

/**
 * The MCP server's recorder: one session per connection, each tool call buffered and written
 * once a second while there are any, and at the end. The answer is read again before each write,
 * so turning sharing off in the app or with `penmoss analytics off` holds from the next one.
 */
export class ToolRecorder {
  private buffer: AnalyticsEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Opened once, on the first write; null once it could not be. */
  private opened: AnalyticsStore | null | undefined;
  private readonly recorder: Recorder;

  constructor(
    private readonly analytics: AnalyticsIo,
    private readonly env: Io['env'],
    private readonly flushMs = TOOL_FLUSH_MS,
  ) {
    this.recorder = recorder(analytics, 'mcp', 'agent', (event) => this.buffer.push(event));
  }

  /** The server's `onToolCall`. */
  readonly record = (call: ToolCallRecord): void => {
    if (this.opened === null) return;
    this.recorder.record('tool', call.tool, {
      agentClient: call.agentClient,
      result: call.result,
      took: durationBucket(call.tookMs),
    });
    if (this.timer === null && this.buffer.length > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.flushMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  };

  /** Writes what is buffered now. */
  flush(): void {
    const events = this.buffer;
    this.buffer = [];
    if (events.length === 0 || this.opened === null) return;
    try {
      write(this.analytics, this.env, events, (this.opened ??= this.analytics.openStore()));
    } catch {
      // No record here: stop trying for this connection, and drop what it had.
      if (this.opened === undefined) this.opened = null;
    }
  }

  /** Writes the rest and lets go of the record. */
  close(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
    try {
      this.opened?.close();
    } catch {
      // Already closed.
    }
    this.opened = null;
  }
}
