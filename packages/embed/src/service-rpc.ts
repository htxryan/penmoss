/**
 * The embedding service over a channel (T76, A1152): the app's utility process serves a
 * `MeaningService` on its parent port, and main calls it with `serviceClient`. Calls carry an
 * id; the service's status changes come as `{ status }` messages.
 */
import type { MeaningHit } from '@penmoss/core/search';
import type { EmbedPort } from './remote-embedder';
import type { MeaningService, ServiceNote, ServiceStatus } from './meaning-service';

/** The calls main makes, as the page makes them (A1152's named calls). */
export interface ServiceCalls {
  status(): Promise<ServiceStatus>;
  update(notebookId: string, notes: readonly ServiceNote[]): Promise<string[]>;
  close(notebookId: string): Promise<void>;
  search(
    notebookId: string,
    query: string,
    options?: { readonly limit?: number; readonly ids?: readonly string[] },
  ): Promise<{ readonly floor: number; readonly hits: MeaningHit[] } | null>;
  setEnabled(enabled: boolean): Promise<ServiceStatus>;
}

export type ServiceMethod = keyof ServiceCalls;
const METHODS: ReadonlySet<string> = new Set<ServiceMethod>([
  'status',
  'update',
  'close',
  'search',
  'setEnabled',
]);

export interface ServiceRequest {
  readonly id: number;
  readonly method: ServiceMethod;
  readonly args: readonly unknown[];
}

export type ServiceMessage =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: string }
  | { readonly status: ServiceStatus };

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

function isRequest(message: unknown): message is ServiceRequest {
  if (typeof message !== 'object' || message === null) return false;
  const request = message as Partial<ServiceRequest>;
  return (
    typeof request.id === 'number' &&
    typeof request.method === 'string' &&
    METHODS.has(request.method) &&
    Array.isArray(request.args)
  );
}

/** The calls on `service` itself. */
export function serviceCalls(service: MeaningService): ServiceCalls {
  return {
    status: () => service.status(),
    update: (notebookId, notes) => service.update(notebookId, notes),
    close: (notebookId) => {
      service.close(notebookId);
      return Promise.resolve();
    },
    search: async (notebookId, query, options) => {
      const hits = await service.search(notebookId, query, options);
      const floor = service.floor();
      return hits && floor !== null ? { floor, hits } : null;
    },
    setEnabled: (enabled) => service.setEnabled(enabled),
  };
}

/** Runs one call on `calls`, as the request names it. */
function dispatch(calls: ServiceCalls, request: ServiceRequest): Promise<unknown> {
  const args: unknown = request.args;
  switch (request.method) {
    case 'status':
      return calls.status();
    case 'update':
      return calls.update(...(args as Parameters<ServiceCalls['update']>));
    case 'close':
      return calls.close(...(args as Parameters<ServiceCalls['close']>));
    case 'search':
      return calls.search(...(args as Parameters<ServiceCalls['search']>));
    case 'setEnabled':
      return calls.setEnabled(...(args as Parameters<ServiceCalls['setEnabled']>));
  }
}

/** The utility process's end: answers each call, in the order they come. */
export function serveService(port: EmbedPort, calls: ServiceCalls): void {
  port.on('message', (message) => {
    if (!isRequest(message)) return;
    void dispatch(calls, message).then(
      (result) => port.postMessage({ id: message.id, result } satisfies ServiceMessage),
      (error: unknown) =>
        port.postMessage({ id: message.id, error: reason(error) } satisfies ServiceMessage),
    );
  });
}

export interface ServiceClient extends ServiceCalls {
  /** Fails every call still waiting (the process exited). */
  failAll(why: string): void;
}

/** Main's end. `onStatus` gets each status the service sends. */
export function serviceClient(
  port: EmbedPort,
  onStatus: (status: ServiceStatus) => void,
): ServiceClient {
  let next = 1;
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  port.on('message', (message) => {
    if (typeof message !== 'object' || message === null) return;
    if ('status' in message) {
      onStatus((message as { status: ServiceStatus }).status);
      return;
    }
    const reply = message as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof reply.id !== 'number') return;
    const call = waiting.get(reply.id);
    if (!call) return;
    waiting.delete(reply.id);
    if (typeof reply.error === 'string') call.reject(new Error(reply.error));
    else call.resolve(reply.result);
  });
  const call = <T>(method: ServiceMethod, ...args: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      port.postMessage({ id, method, args } satisfies ServiceRequest);
    });
  return {
    status: () => call('status'),
    update: (notebookId, notes) => call('update', notebookId, notes),
    close: (notebookId) => call('close', notebookId),
    search: (notebookId, query, options) => call('search', notebookId, query, options ?? {}),
    setEnabled: (enabled) => call('setEnabled', enabled),
    failAll: (why) => {
      for (const { reject } of waiting.values()) reject(new Error(why));
      waiting.clear();
    },
  };
}
