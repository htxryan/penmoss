// Scratch: EmbeddingGemma q4 through transformers.js (native CPU) as an Embedder, for eval:search before T72.
import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
env.cacheDir = process.env.MODEL_CACHE;
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map((x) => x / s); };
export async function evalEmbedder() {
  const id = 'onnx-community/embeddinggemma-300m-ONNX';
  const tok = await AutoTokenizer.from_pretrained(id);
  const model = await AutoModel.from_pretrained(id, { dtype: 'q4' });
  const run = async (texts) => {
    const out = [];
    for (let i = 0; i < texts.length; i += 8) {
      const inputs = await tok(texts.slice(i, i + 8), { padding: true, truncation: true, max_length: 1024 });
      const { sentence_embedding: t } = await model(inputs);
      const [n, d] = t.dims;
      for (let j = 0; j < n; j++) out.push(norm(t.data.slice(j * d, (j + 1) * d)));
    }
    return out;
  };
  return {
    model: 'embeddinggemma-300m-q4@5090578d/768/p1', dimensions: 768, floor: 0.28,
    embedQuery: async (q) => (await run([`task: search result | query: ${q}`]))[0],
    embedDocuments: (texts) => run(texts.map((t) => `title: none | text: ${t}`)),
  };
}
