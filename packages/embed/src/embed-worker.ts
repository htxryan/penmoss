/**
 * The embedding worker thread (T75, A1152): `penmoss mcp` starts it so that inference never
 * blocks the agent's requests. It opens the model it is given and serves `EmbedRequest`s.
 * Bundled as `dist/embed-worker.cjs` beside the app's main bundle.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { ModelManifest } from './manifest';
import { createOnnxEmbedder } from './onnx-embedder';
import { serveEmbedder, type EmbedderInfo } from './remote-embedder';

export interface EmbedWorkerData {
  readonly dir: string;
  readonly manifest: ModelManifest;
  readonly threads: number;
  readonly wasmPaths?: string;
}

export type EmbedWorkerHello = { readonly ready: EmbedderInfo } | { readonly failed: string };

if (parentPort) {
  const port = parentPort;
  const data = workerData as EmbedWorkerData;
  createOnnxEmbedder({
    dir: data.dir,
    manifest: data.manifest,
    threads: data.threads,
    ...(data.wasmPaths ? { wasmPaths: data.wasmPaths } : {}),
  }).then(
    (embedder) => {
      serveEmbedder(port, embedder);
      port.postMessage({
        ready: { model: embedder.model, dimensions: embedder.dimensions, floor: embedder.floor },
      } satisfies EmbedWorkerHello);
    },
    (error: unknown) =>
      port.postMessage({
        failed: error instanceof Error ? error.message : String(error),
      } satisfies EmbedWorkerHello),
  );
}
