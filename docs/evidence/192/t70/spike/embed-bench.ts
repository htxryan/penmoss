// T70 spike (throwaway): EmbeddingGemma q4 on onnxruntime-web's WASM, in whatever process runs it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-web';

export interface BenchResult {
  where: string;
  threads: number;
  loadMs: number;
  msPerChunk: number;
  msPerQuery: number;
  rssMb: number;
  dims: number;
  wasmPaths: string;
  error?: string;
}

export async function runEmbedBench(modelDir: string, ortDir: string, threads: number, where: string): Promise<BenchResult> {
  const result: BenchResult = { where, threads, loadMs: 0, msPerChunk: 0, msPerQuery: 0, rssMb: 0, dims: 0, wasmPaths: ortDir };
  try {
    ort.env.wasm.wasmPaths = ortDir.endsWith('/') ? ortDir : ortDir + '/';
    ort.env.wasm.numThreads = threads;
    let t = performance.now();
    const tokenizer = new Tokenizer(
      JSON.parse(readFileSync(join(modelDir, 'tokenizer.json'), 'utf8')),
      JSON.parse(readFileSync(join(modelDir, 'tokenizer_config.json'), 'utf8')),
    );
    const session = await ort.InferenceSession.create(readFileSync(join(modelDir, 'onnx', 'model_q4.onnx')), {
      executionProviders: ['wasm'],
      externalData: [{ path: 'model_q4.onnx_data', data: readFileSync(join(modelDir, 'onnx', 'model_q4.onnx_data')) }],
    });
    result.loadMs = Math.round(performance.now() - t);
    const embed = async (texts: string[]) => {
      const enc = texts.map((text) => tokenizer.encode(text).ids as number[]);
      const width = Math.max(...enc.map((ids) => ids.length));
      const ids = new BigInt64Array(texts.length * width);
      const mask = new BigInt64Array(texts.length * width);
      enc.forEach((row, r) => row.forEach((id, c) => { ids[r * width + c] = BigInt(id); mask[r * width + c] = 1n; }));
      const out = await session.run({
        input_ids: new ort.Tensor('int64', ids, [texts.length, width]),
        attention_mask: new ort.Tensor('int64', mask, [texts.length, width]),
      });
      return out.sentence_embedding;
    };
    const text = 'title: none | text: ' + 'Home lab power use and the UPS shutdown plan for long outages. '.repeat(3);
    const first = await embed([text]);
    result.dims = first.dims[1] as number;
    t = performance.now();
    for (let k = 0; k < 4; k++) await embed(Array(8).fill(text));
    result.msPerChunk = +((performance.now() - t) / 32).toFixed(1);
    t = performance.now();
    for (let k = 0; k < 10; k++) await embed(['task: search result | query: keep the computers running during a blackout']);
    result.msPerQuery = +((performance.now() - t) / 10).toFixed(1);
    result.rssMb = Math.round(process.memoryUsage().rss / 1e6);
  } catch (error) {
    result.error = String((error as Error)?.stack ?? error).slice(0, 800);
  }
  return result;
}
