/**
 * Search by meaning for a Node process on the Mac (T75, A1151–A1158): the CLI's
 * `penmoss models` and `search`, and `penmoss mcp`, as the app's binary runs them. The model
 * folder, the vector cache and the lease in `~/.penmoss`, and the per-Mac setting
 * (`~/.penmoss/meaning.json`, on unless it says `"enabled": false`).
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Embedder, VectorCache } from '@penmoss/core/search';
import type { EmbedWorkerData, EmbedWorkerHello } from './embed-worker';
import { FileVectorCache, vectorsDir } from './file-cache';
import { Lease } from './lease';
import { EMBEDDING_GEMMA, modelId, type ModelManifest } from './manifest';
import { fetchModel, modelStatus, openModel, removeModel } from './model-store';
import { createOnnxEmbedder } from './onnx-embedder';
import { remoteEmbedder } from './remote-embedder';

export interface MeaningStatus {
  /** Settings → Search by Meaning on this Mac (A1158). */
  readonly enabled: boolean;
  readonly state: 'absent' | 'partial' | 'ready';
  readonly bytes: number;
  readonly totalBytes: number;
  /** The embedder's model id (name, revision, dimensions, prompts). */
  readonly model: string;
  readonly repository: string;
  readonly revision: string;
  readonly dir: string;
  readonly license: { readonly name: string; readonly url: string };
}

export interface MeaningLease {
  held(): Promise<boolean>;
  release(): Promise<void>;
}

export interface OpenedMeaning {
  readonly embedder: Embedder;
  readonly cache: VectorCache & { compact(keep: ReadonlySet<string>): Promise<number> };
  /** The indexer lease (A1157), or undefined while another process holds it. */
  lease(): Promise<MeaningLease | undefined>;
  close(): Promise<void>;
}

export interface NodeMeaningOptions {
  readonly home: string;
  readonly manifest?: ModelManifest;
  /** Where onnxruntime-web's `.mjs` and `.wasm` are, in a bundle (the app's `dist/ort`). */
  readonly wasmPaths?: string;
  /** The bundled worker (`dist/embed-worker.cjs`); without it, `thread` embeds in-process. */
  readonly workerPath?: string;
  readonly threads?: number;
  /** Tests: Hugging Face's stand-in. */
  readonly baseUrl?: string;
}

const settingsPath = (home: string) => join(home, 'meaning.json');

/** Settings → Search by Meaning (A1158): on unless switched off. */
export async function meaningEnabled(home: string): Promise<boolean> {
  const text = await readFile(settingsPath(home), 'utf8').catch(() => null);
  if (text === null) return true;
  try {
    return (JSON.parse(text) as { enabled?: unknown }).enabled !== false;
  } catch {
    return true;
  }
}

export async function setMeaningEnabled(home: string, enabled: boolean): Promise<void> {
  await writeFile(settingsPath(home), `${JSON.stringify({ enabled }, null, 2)}\n`);
}

export class NodeMeaning {
  readonly manifest: ModelManifest;

  constructor(private readonly options: NodeMeaningOptions) {
    this.manifest = options.manifest ?? EMBEDDING_GEMMA;
  }

  get home(): string {
    return this.options.home;
  }

  async status(): Promise<MeaningStatus> {
    const [enabled, status] = await Promise.all([
      meaningEnabled(this.home),
      modelStatus(this.manifest, this.home),
    ]);
    return {
      enabled,
      state: status.state,
      bytes: status.bytes,
      totalBytes: status.totalBytes,
      model: modelId(this.manifest),
      repository: this.manifest.repo,
      revision: this.manifest.revision,
      dir: status.dir,
      license: this.manifest.license,
    };
  }

  async fetch(
    onProgress?: (received: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<MeaningStatus> {
    await fetchModel(this.manifest, {
      home: this.home,
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
      ...(onProgress ? { onProgress: ({ received, total }) => onProgress(received, total) } : {}),
      ...(signal ? { signal } : {}),
    });
    return this.status();
  }

  /** Settings → Search by Meaning on this Mac (A1158). */
  setEnabled(enabled: boolean): Promise<void> {
    return setMeaningEnabled(this.home, enabled);
  }

  /** Deletes the model and this model's vectors. */
  async remove(): Promise<void> {
    await removeModel(this.manifest, this.home);
    await rm(vectorsDir(this.home, modelId(this.manifest)), { recursive: true, force: true });
  }

  /**
   * The model and vectors for `writer`, or null when Search by Meaning is off or the model is not
   * here. Throws `ModelError('corrupt')` when a file fails its checksum (it is deleted, so a fetch
   * gets it again). With `thread`, inference runs in a worker thread.
   */
  async open(
    writer: 'cli' | 'mcp' | 'app',
    options: { readonly thread?: boolean } = {},
  ): Promise<OpenedMeaning | null> {
    const status = await this.status();
    if (!status.enabled || status.state !== 'ready') return null;
    const dir = await openModel(this.manifest, this.home);
    const threads = this.options.threads ?? 4;
    let embedder: Embedder;
    let close: () => Promise<void>;
    if (options.thread && this.options.workerPath) {
      const worker = new Worker(this.options.workerPath, {
        workerData: {
          dir,
          manifest: this.manifest,
          threads,
          ...(this.options.wasmPaths ? { wasmPaths: this.options.wasmPaths } : {}),
        } satisfies EmbedWorkerData,
      });
      const hello = await new Promise<EmbedWorkerHello>((resolve, reject) => {
        worker.once('message', (message: EmbedWorkerHello) => resolve(message));
        worker.once('error', reject);
        // A worker that exits before it answers must not leave every caller waiting.
        worker.once('exit', (code) =>
          reject(new Error(`The embedding worker stopped (exit code ${code}) before it opened.`)),
        );
      });
      if ('failed' in hello) {
        await worker.terminate();
        throw new Error(`The model did not open: ${hello.failed}`);
      }
      const remote = remoteEmbedder(worker, hello.ready);
      worker.on('error', (error: Error) => remote.failAll(error.message));
      worker.on('exit', () => remote.failAll('The embedding worker stopped.'));
      worker.unref();
      embedder = remote;
      close = async () => {
        await worker.terminate();
      };
    } else {
      const onnx = await createOnnxEmbedder({
        dir,
        manifest: this.manifest,
        threads,
        ...(this.options.wasmPaths ? { wasmPaths: this.options.wasmPaths } : {}),
      });
      embedder = onnx;
      close = () => onnx.dispose();
    }
    const cache = new FileVectorCache({
      home: this.home,
      model: embedder.model,
      dimensions: embedder.dimensions,
      writer,
    });
    const leases: Lease[] = [];
    return {
      embedder,
      cache,
      lease: async () => {
        const lease = await Lease.acquire(this.home, writer);
        if (lease) leases.push(lease);
        return lease;
      },
      close: async () => {
        for (const lease of leases) await lease.release();
        await close();
      },
    };
  }
}
