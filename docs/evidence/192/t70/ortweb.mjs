import * as ort from 'onnxruntime-web';
import { AutoTokenizer, env } from '@huggingface/transformers';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
env.cacheDir = process.env.MODEL_CACHE;
const id = 'onnx-community/embeddinggemma-300m-ONNX';
const dir = join(process.env.MODEL_CACHE, id, 'onnx');
ort.env.wasm.numThreads = Number(process.env.T || 1);
const tok = await AutoTokenizer.from_pretrained(id);
let t = performance.now();
const session = await ort.InferenceSession.create(readFileSync(join(dir, 'model_q4.onnx')), {
  executionProviders: ['wasm'],
  externalData: [{ path: 'model_q4.onnx_data', data: readFileSync(join(dir, 'model_q4.onnx_data')) }],
});
const load = performance.now() - t;
const run = async (texts) => {
  const enc = await tok(texts, { padding: true, truncation: true });
  const feeds = {};
  for (const name of session.inputNames) { const x = enc[name]; feeds[name] = new ort.Tensor('int64', BigInt64Array.from(x.data, BigInt), x.dims); }
  return (await session.run(feeds)).sentence_embedding;
};
const text = 'title: none | text: ' + 'Home lab power use and the UPS shutdown plan for long outages. '.repeat(3);
await run([text]);
t = performance.now(); for (let k = 0; k < 4; k++) await run(Array(8).fill(text)); const per = (performance.now() - t) / 32;
t = performance.now(); for (let k = 0; k < 10; k++) await run(['task: search result | query: keep the computers running during a blackout']); const q = (performance.now() - t) / 10;
console.log(JSON.stringify({ backend: 'onnxruntime-web wasm in node', threads: ort.env.wasm.numThreads, inputs: session.inputNames, loadMs: Math.round(load), msPerChunk: +per.toFixed(1), msPerQuery: +q.toFixed(1) }));
