/**
 * The recorder every JavaScript client uses (PEN-137): it stamps an event with its session, its
 * `seq` and the time, fills in the client's fields, checks it against the catalogue and hands it
 * to a sink (the page's IPC to main, main's worker, the CLI's or MCP server's store). An event
 * that fails the check is dropped, never stored: a bug in a client cannot record free text.
 * Recording never throws and never waits.
 */
import {
  newSessionId,
  type AnalyticsEvent,
  type ClientFields,
  type EventKind,
  type Props,
} from './events';
import { eventProblem } from './validate';

export type EventSink = (event: AnalyticsEvent) => void;

export interface RecorderOptions {
  readonly fields: () => ClientFields;
  readonly sink: EventSink;
  readonly session?: string;
  readonly now?: () => number;
  /** Told of each event dropped, and why (tests make this throw). */
  readonly onDropped?: (problem: string, kind: string, name: string) => void;
}

export class Recorder {
  readonly session: string;
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly options: RecorderOptions) {
    this.session = options.session ?? newSessionId();
    this.now = options.now ?? Date.now;
  }

  /** Records one event; false when it was dropped. */
  record(kind: EventKind, name: string, props: Props = {}): boolean {
    try {
      const event: AnalyticsEvent = {
        session: this.session,
        seq: this.seq,
        at: this.now(),
        ...withoutUndefined(this.options.fields()),
        kind,
        name,
        props: withoutUndefined(props),
      };
      const problem = eventProblem(event);
      if (problem) {
        this.options.onDropped?.(problem, kind, name);
        return false;
      }
      this.seq += 1;
      this.options.sink(event);
      return true;
    } catch {
      return false;
    }
  }
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
