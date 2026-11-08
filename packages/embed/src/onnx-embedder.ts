/**
 * EmbeddingGemma as an `Embedder` (A1152, T70): onnxruntime-web's threaded WASM in whatever Node
 * process runs it (the app's embedding service, the CLI, the local MCP), with the Hugging Face
 * tokenizer in plain JavaScript, so nothing native ships. Texts are batched by length, run one
 * batch at a time, and come back normalised in the order given.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import { normalize, type Embedder } from '@penmoss/core/search';
import * as ort from 'onnxruntime-web';
import { modelId, type ModelManifest } from './manifest';

export interface OnnxEmbedderOptions {
  /** The model's folder (`openModel`'s answer). */
  readonly dir: string;
  readonly manifest: ModelManifest;
  /**
   * WASM threads (A1152: 4 in the embedding service). onnxruntime fixes this on its first session
   * in a process, so a later, different value has no effect.
   */
  readonly threads?: number;
  /** Where `ort-wasm-simd-threaded.{mjs,wasm}` are, when not beside onnxruntime-web (the app's bundle). */
  readonly wasmPaths?: string;
  /** Texts a run (default 8). */
  readonly batch?: number;
}

export interface OnnxEmbedder extends Embedder {
  dispose(): Promise<void>;
}

interface TokenizerConfig {
  readonly pad_token?: string;
}

export async function createOnnxEmbedder(options: OnnxEmbedderOptions): Promise<OnnxEmbedder> {
  const { dir, manifest } = options;
  if (options.wasmPaths)
    ort.env.wasm.wasmPaths = options.wasmPaths.endsWith('/')
      ? options.wasmPaths
      : `${options.wasmPaths}/`;
  if (options.threads) ort.env.wasm.numThreads = options.threads;
  const [tokenizerJson, configJson] = await Promise.all([
    readFile(join(dir, manifest.tokenizer), 'utf8'),
    readFile(join(dir, manifest.tokenizerConfig), 'utf8'),
  ]);
  const config = JSON.parse(configJson) as TokenizerConfig;
  const tokenizer = new Tokenizer(JSON.parse(tokenizerJson) as object, config);
  const padId =
    config.pad_token !== undefined
      ? (tokenizer.encode(config.pad_token, { add_special_tokens: false }).ids[0] ?? 0)
      : 0;
  const externalData = await Promise.all(
    manifest.externalData.map(async (path) => ({
      path: path.split('/').pop()!,
      data: new Uint8Array(await readFile(join(dir, path))),
    })),
  );
  const session = await ort.InferenceSession.create(
    new Uint8Array(await readFile(join(dir, manifest.graph))),
    {
      executionProviders: ['wasm'],
      externalData,
    },
  );
  const batchSize = options.batch ?? 8;
  let queue: Promise<unknown> = Promise.resolve();

  const tokens = (text: string): number[] => {
    const ids = tokenizer.encode(text).ids;
    // Too long: keep the start and the closing token.
    return ids.length <= manifest.maxTokens
      ? ids
      : [...ids.slice(0, manifest.maxTokens - 1), ids[ids.length - 1]!];
  };

  const run = async (rows: number[][]): Promise<Float32Array[]> => {
    const width = Math.max(1, ...rows.map((row) => row.length));
    const ids = new BigInt64Array(rows.length * width).fill(BigInt(padId));
    const mask = new BigInt64Array(rows.length * width);
    rows.forEach((row, r) =>
      row.forEach((id, c) => {
        ids[r * width + c] = BigInt(id);
        mask[r * width + c] = 1n;
      }),
    );
    const feeds = {
      input_ids: new ort.Tensor('int64', ids, [rows.length, width]),
      attention_mask: new ort.Tensor('int64', mask, [rows.length, width]),
    };
    const result = await session.run(feeds);
    const output = result[manifest.output];
    if (!output) throw new Error(`The model has no ${manifest.output} output.`);
    const data = output.data as Float32Array;
    const dims = output.dims[1] as number;
    const out: Float32Array[] = [];
    for (let r = 0; r < rows.length; r++) {
      out.push(normalize(data.slice(r * dims, r * dims + Math.min(dims, manifest.dimensions))));
    }
    for (const tensor of Object.values(result)) tensor.dispose();
    return out;
  };

  const embed = (texts: readonly string[]): Promise<Float32Array[]> => {
    const next = queue.then(async () => {
      const rows = texts.map(tokens);
      // Similar lengths together, so a batch pads little.
      const order = rows.map((_, i) => i).sort((a, b) => rows[a]!.length - rows[b]!.length);
      const out = new Array<Float32Array>(texts.length);
      for (let i = 0; i < order.length; i += batchSize) {
        const slice = order.slice(i, i + batchSize);
        const vectors = await run(slice.map((index) => rows[index]!));
        slice.forEach((index, k) => (out[index] = vectors[k]!));
      }
      return out;
    });
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    model: modelId(manifest),
    dimensions: manifest.dimensions,
    floor: manifest.floor,
    embedQuery: async (text) => (await embed([`${manifest.prompts.query}${text}`]))[0]!,
    embedDocuments: (texts) => embed(texts.map((text) => `${manifest.prompts.document}${text}`)),
    dispose: () => session.release(),
  };
}
