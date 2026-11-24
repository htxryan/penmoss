/**
 * Main's side of the IPC contract (ipc-contract.ts): handlers registered by name, with the
 * channel's guard and gesture rule applied before they run, and typed answers. A handler still
 * checks each argument itself: the page's arguments arrive as `unknown`, whatever the contract
 * says the page sends (A224).
 */
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  EVENT,
  INVOKE,
  SEND,
  type Caller,
  type EventName,
  type Events,
  type InvokeArgs,
  type InvokeName,
  type InvokeResult,
  type InvokeRule,
  type SendName,
  type Sends,
} from './ipc-contract';

/** Whether a message's sender is one `from` allows (main.ts's `fromApp`, `fromAppWindow`, …). */
type CallerCheck = (from: Caller, event: IpcMainEvent | IpcMainInvokeEvent) => boolean;

interface IpcCall<E> {
  readonly event: E;
  /** A key press or click had just happened in the page (the rule's `gesture`; else false). */
  readonly gesture: boolean;
}

/** The page's arguments, one `unknown` for each the contract names. */
type Unchecked<A extends readonly unknown[]> = { -readonly [I in keyof A]: unknown };
type Awaitable<T> = T | Promise<T>;

const INVOKE_RULES: { readonly [K in InvokeName]: InvokeRule<InvokeResult<K>> } = INVOKE;

/** Takes the gesture off the front of the arguments when the rule says the preload sends one. */
function split(hasGesture: boolean, raw: unknown[]): { gesture: boolean; args: unknown[] } {
  return hasGesture
    ? { gesture: raw[0] === true, args: raw.slice(1) }
    : { gesture: false, args: raw };
}

export class IpcHandlers {
  constructor(
    private readonly ipc: Pick<IpcMain, 'handle' | 'on'>,
    private readonly allows: CallerCheck,
  ) {}

  /**
   * Answers a page's call. A sender `from` does not allow gets the rule's `refused` (null when it
   * has none); without the gesture a `{ refused }` rule asks for, its `refused`.
   */
  handle<K extends InvokeName>(
    name: K,
    fn: (
      call: IpcCall<IpcMainInvokeEvent>,
      ...args: Unchecked<InvokeArgs<K>>
    ) => Awaitable<InvokeResult<K>>,
  ): void {
    const rule = INVOKE_RULES[name];
    this.ipc.handle(rule.channel, (event, ...raw: unknown[]) => {
      const { gesture, args } = split(rule.gesture !== undefined, raw);
      if (!this.allows(rule.from, event)) return rule.refused ?? null;
      if (typeof rule.gesture === 'object' && !gesture) return rule.gesture.refused;
      return fn({ event, gesture }, ...(args as Unchecked<InvokeArgs<K>>));
    });
  }

  /** Takes a page's message; one from a sender the rule does not allow is dropped. */
  on<K extends SendName>(
    name: K,
    fn: (call: IpcCall<IpcMainEvent>, ...args: Unchecked<Sends[K]>) => void,
  ): void {
    const rule = SEND[name];
    const from = rule.from;
    if (from === null) throw new Error(`${name} has no guard: main listens for it itself`);
    this.ipc.on(rule.channel, (event, ...args: unknown[]) => {
      if (!this.allows(from, event)) return;
      fn({ event, gesture: false }, ...(args as Unchecked<Sends[K]>));
    });
  }
}

/** The value an event carries; optional when it may carry none. */
export type EventValue<K extends EventName> = undefined extends Events[K]
  ? [value?: Events[K]]
  : [value: Events[K]];

/** Sends a page one of the contract's events. */
export function sendEvent<K extends EventName>(
  contents: { send(channel: string, ...args: unknown[]): void },
  name: K,
  ...value: EventValue<K>
): void {
  contents.send(EVENT[name], ...value);
}
