import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
env.cacheDir = process.env.MODEL_CACHE;
const id = 'onnx-community/embeddinggemma-300m-ONNX';
for (const device of ['wasm', 'cpu']) {
  try {
    let t = performance.now();
    const tok = await AutoTokenizer.from_pretrained(id);
    const model = await AutoModel.from_pretrained(id, { dtype: 'q4', device });
    const load = performance.now() - t;
    const text = 'title: none | text: ' + 'Home lab power use and the UPS shutdown plan for long outages. '.repeat(3);
    const one = async (b) => { const i = await tok(b, { padding: true, truncation: true }); return (await model(i)).sentence_embedding; };
    await one([text]);
    t = performance.now(); for (let k = 0; k < 4; k++) await one(Array(8).fill(text)); const per = (performance.now() - t) / 32;
    t = performance.now(); for (let k = 0; k < 10; k++) await one(['task: search result | query: keep the computers running during a blackout']); const q = (performance.now() - t) / 10;
    const e = await one(['task: search result | query: x']);
    console.log(JSON.stringify({ device, loadMs: Math.round(load), msPerChunk: +per.toFixed(1), msPerQuery: +q.toFixed(1), dims: e.dims, threads: env.backends?.onnx?.wasm?.numThreads }));
  } catch (err) { console.log(device, 'ERR', String(err).slice(0, 300)); }
}
