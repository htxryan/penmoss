/**
 * An `Embedder` in another thread or process (A1152): the MCP server's worker thread (T75) and
 * the app's embedding service (T76) run `OnnxEmbedder` there, so inference never blocks the
 * process that answers agents or draws the page. Requests carry an id. Documents are embedded a
 * few at a time and a query that arrives meanwhile goes next, so a search waits for at most one
 * small batch.
 */
import type { Embedder } from '@penmoss/core/search';

/** One end of a worker's or a utility process's channel. */
export interface EmbedPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}

export interface EmbedRequest {
  readonly id: number;
  readonly op: 'query' | 'documents';
  readonly texts: readonly string[];
}

export type EmbedReply =
  | { readonly id: number; readonly vectors: Float32Array[] }
  | { readonly id: number; readonly error: string };

function isRequest(message: unknown): message is EmbedRequest {
  if (typeof message !== 'object' || message === null) return false;
  const request = message as Partial<EmbedRequest>;
  return (
    typeof request.id === 'number' &&
    (request.op === 'query' || request.op === 'documents') &&
    Array.isArray(request.texts)
  );
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The far end: answers requests with `embedder`, one run at a time, queries first. */
export function serveEmbedder(port: EmbedPort, embedder: Embedder, batch = 2): void {
  const queries: EmbedRequest[] = [];
  const documents: EmbedRequest[] = [];
  let busy = false;

  const answerQueries = async () => {
    for (let request = queries.shift(); request; request = queries.shift()) {
      try {
        const vectors = [];
        for (const text of request.texts) vectors.push(await embedder.embedQuery(text));
        port.postMessage({ id: request.id, vectors } satisfies EmbedReply);
      } catch (error) {
        port.postMessage({ id: request.id, error: reason(error) } satisfies EmbedReply);
      }
    }
  };

  const work = async () => {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        await answerQueries();
        const request = documents.shift();
        if (!request) break;
        try {
          const vectors: Float32Array[] = [];
          for (let i = 0; i < request.texts.length; i += batch) {
            vectors.push(...(await embedder.embedDocuments(request.texts.slice(i, i + batch))));
            await answerQueries();
          }
          port.postMessage({ id: request.id, vectors } satisfies EmbedReply);
        } catch (error) {
          port.postMessage({ id: request.id, error: reason(error) } satisfies EmbedReply);
        }
      }
    } finally {
      busy = false;
    }
  };

  port.on('message', (message) => {
    if (!isRequest(message)) return;
    (message.op === 'query' ? queries : documents).push(message);
    void work();
  });
}

/** What the far end's embedder is, sent before any request. */
export interface EmbedderInfo {
  readonly model: string;
  readonly dimensions: number;
  readonly floor: number;
}

/** An `Embedder` that asks the far end of `port`. */
export function remoteEmbedder(
  port: EmbedPort,
  info: EmbedderInfo,
): Embedder & { failAll(error: string): void } {
  let next = 1;
  const waiting = new Map<
    number,
    { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }
  >();
  port.on('message', (message) => {
    const reply = message as Partial<EmbedReply> & { id?: unknown };
    if (typeof reply.id !== 'number') return;
    const pending = waiting.get(reply.id);
    if (!pending) return;
    waiting.delete(reply.id);
    if ('error' in reply && typeof reply.error === 'string') pending.reject(new Error(reply.error));
    else if ('vectors' in reply && Array.isArray(reply.vectors)) pending.resolve(reply.vectors);
  });
  const ask = (op: EmbedRequest['op'], texts: readonly string[]) =>
    texts.length === 0
      ? Promise.resolve([])
      : new Promise<Float32Array[]>((resolve, reject) => {
          const id = next++;
          waiting.set(id, { resolve, reject });
          port.postMessage({ id, op, texts: [...texts] } satisfies EmbedRequest);
        });
  return {
    ...info,
    embedQuery: async (text) => (await ask('query', [text]))[0]!,
    embedDocuments: (texts) => ask('documents', texts),
    failAll(error) {
      for (const pending of waiting.values()) pending.reject(new Error(error));
      waiting.clear();
    },
  };
}
