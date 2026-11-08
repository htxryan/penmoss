/**
 * Calls between the app and the git engine page (T50 G7, A873), over frames (`frames.ts`). Each
 * side calls the other's operations by name and gets one answer per call: `{k:'call', id, op, a}`
 * is answered by `{k:'ok', id, v}` or `{k:'err', id, e}`; `{k:'ev', n, v}` is an event, which has
 * no answer. The page calls the app's git, secrets and owner checks; the app calls the page's
 * engine and its local notes server.
 */
import { decodeFrame, encodeFrame } from './frames';

/** Where frames go and come from: the WebView's `penmossNative`, or stdio in the JVM tests. */
export interface FramePort {
  send(frame: Uint8Array): void;
  listen(listener: (frame: Uint8Array) => void): void;
}

/** A refusal or failure as it crosses: a code, plain words, and the git host's own words. */
export interface WireError {
  readonly code: string;
  readonly message: string;
  readonly hostMessage?: string;
}

/** What a call to the other side failed with. */
export class ChannelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hostMessage?: string,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

export type Handler = (args: unknown) => unknown;

interface Waiting {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

export class Channel {
  private next = 1;
  private readonly waiting = new Map<number, Waiting>();
  private readonly events = new Map<string, Set<(value: unknown) => void>>();

  constructor(
    private readonly port: FramePort,
    private readonly handlers: Readonly<Record<string, Handler>>,
    /** Turns a handler's failure into what the other side reads. */
    private readonly describe: (error: unknown) => WireError = describeError,
  ) {
    port.listen((frame) => this.receive(frame));
  }

  /** Calls the other side; `timeoutMs` fails it as `timeout` when no answer comes in time. */
  call(op: string, args: unknown = null, timeoutMs?: number): Promise<unknown> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.waiting.delete(id);
              reject(new ChannelError('timeout', `The app did not answer ${op} in time.`));
            }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      try {
        this.port.send(encodeFrame({ k: 'call', id, op, a: args }));
      } catch (error) {
        this.waiting.delete(id);
        if (timer) clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Tells the other side something; nothing answers. */
  emit(name: string, value: unknown = null): void {
    this.port.send(encodeFrame({ k: 'ev', n: name, v: value }));
  }

  /** Events the other side sends (tests; the page sends events, the app does not yet). */
  on(name: string, listener: (value: unknown) => void): () => void {
    let set = this.events.get(name);
    if (!set) this.events.set(name, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  private receive(frame: Uint8Array): void {
    let message: Record<string, unknown>;
    try {
      message = decodeFrame(frame);
    } catch {
      return;
    }
    const id = message['id'];
    switch (message['k']) {
      case 'call': {
        if (typeof id !== 'number' || typeof message['op'] !== 'string') return;
        void this.answer(id, message['op'], message['a']);
        return;
      }
      case 'ok':
      case 'err': {
        if (typeof id !== 'number') return;
        const waiting = this.waiting.get(id);
        if (!waiting) return;
        this.waiting.delete(id);
        if (waiting.timer) clearTimeout(waiting.timer);
        if (message['k'] === 'ok') {
          waiting.resolve(message['v'] ?? null);
        } else {
          const error = (message['e'] ?? {}) as Partial<WireError>;
          waiting.reject(
            new ChannelError(
              typeof error.code === 'string' ? error.code : 'error',
              typeof error.message === 'string' ? error.message : 'The call failed.',
              typeof error.hostMessage === 'string' ? error.hostMessage : undefined,
            ),
          );
        }
        return;
      }
      case 'ev': {
        const name = message['n'];
        if (typeof name !== 'string') return;
        for (const listener of this.events.get(name) ?? []) listener(message['v'] ?? null);
        return;
      }
      default:
        return;
    }
  }

  private async answer(id: number, op: string, args: unknown): Promise<void> {
    const handler = Object.hasOwn(this.handlers, op) ? this.handlers[op] : undefined;
    let reply: Record<string, unknown>;
    if (!handler) {
      reply = { k: 'err', id, e: { code: 'unknown_call', message: `No such call: ${op}` } };
    } else {
      try {
        reply = { k: 'ok', id, v: (await handler(args)) ?? null };
      } catch (error) {
        reply = { k: 'err', id, e: this.describe(error) };
      }
    }
    try {
      this.port.send(encodeFrame(reply));
    } catch (error) {
      this.port.send(encodeFrame({ k: 'err', id, e: describeError(error) }));
    }
  }
}

export function describeError(error: unknown): WireError {
  if (error instanceof ChannelError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.hostMessage ? { hostMessage: error.hostMessage } : {}),
    };
  }
  const coded = error as { code?: unknown; message?: unknown; hostMessage?: unknown } | null;
  return {
    code: typeof coded?.code === 'string' ? coded.code : 'error',
    message:
      typeof coded?.message === 'string'
        ? coded.message
        : error instanceof Error
          ? error.message
          : 'The call failed.',
    ...(typeof coded?.hostMessage === 'string' ? { hostMessage: coded.hostMessage } : {}),
  };
}

/** The page's port: `penmossNative`, which the app registers for the asset loader's origin. */
export function nativePort(): FramePort | null {
  const native = (
    globalThis as unknown as {
      penmossNative?: {
        postMessage(message: ArrayBuffer | string): void;
        onmessage: ((event: { data: unknown }) => void) | null;
      };
    }
  ).penmossNative;
  if (!native) return null;
  return {
    send: (frame) =>
      native.postMessage(
        frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength
          ? (frame.buffer as ArrayBuffer)
          : frame.slice().buffer,
      ),
    listen: (listener) => {
      native.onmessage = (event) => {
        // A string is not a frame: the git page takes binary frames only (A873).
        if (event.data instanceof ArrayBuffer) listener(new Uint8Array(event.data));
      };
    },
  };
}
