// Embedding model bake-off on Penmoss's own labelled search eval (#192 design pass).
// Words: LocalSearchIndex (what git notebooks use today). Meaning: each model over chunkNote chunks.
// Hybrid: RRF of the two top-50 lists, meaning-only hits below a floor dropped, title matches first (as the old fuseHybrid).
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chunkNote, parseQuery, reciprocalRankFusion, MATCH_START } from '@penmoss/core/search';
import { LocalSearchIndex } from '/Users/redhale/src/penmoss-wt/t70-search-by-meaning/packages/sync-client/src/local-index';
import { EVAL_DISTRACTORS, SEARCH_EVAL, SEARCH_EVAL_KEYWORDS } from '/Users/redhale/src/penmoss-wt/t70-search-by-meaning/packages/core/test/support/search-eval';
import { SEARCH_VAULT } from '/Users/redhale/src/penmoss-wt/t70-search-by-meaning/packages/core/test/support/search-vault';
import { vaultDocuments } from '/Users/redhale/src/penmoss-wt/t70-search-by-meaning/packages/core/test/support/search-vault-docs';
import { AutoModel, AutoTokenizer, env, pipeline } from '@huggingface/transformers';

const CACHE = process.env.MODEL_CACHE!;
env.cacheDir = CACHE;

const UNRELATED = [
  'zqxjkv wplmorth', 'quantum chromodynamics lattice gauge theory', 'medieval tapestry weaving looms',
  'saxophone reed strength for jazz', 'volcanic rock formations in Iceland', 'cricket bowling technique for spin',
  'knitting a cable sweater pattern', 'xyzzy plugh', 'the history of the Byzantine empire', 'how to tune a ukulele',
];

type Embed = (texts: string[], kind: 'query' | 'doc') => Promise<Float32Array[]>;
interface Model { name: string; id: string; dtype?: string; make: () => Promise<Embed> }

function norm(v: Float32Array): Float32Array {
  let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1;
  return v.map((x) => x / s) as Float32Array;
}
function rows(t: { data: Float32Array; dims: number[] }): Float32Array[] {
  const [n, d] = t.dims; const out: Float32Array[] = [];
  for (let i = 0; i < n; i++) out.push(norm(t.data.slice(i * d, (i + 1) * d) as Float32Array));
  return out;
}

const pipe = (id: string, dtype: string, pooling: 'cls' | 'mean', qp = '', dp = ''): (() => Promise<Embed>) => async () => {
  const fe = await pipeline('feature-extraction', id, { dtype: dtype as never });
  return async (texts, kind) => {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 8) {
      const batch = texts.slice(i, i + 8).map((t) => (kind === 'query' ? qp : dp) + t);
      out.push(...rows((await fe(batch, { pooling, normalize: true })) as never));
    }
    return out;
  };
};

const gemma = (dtype: string, dims = 768) => async (): Promise<Embed> => {
  const id = 'onnx-community/embeddinggemma-300m-ONNX';
  const tok = await AutoTokenizer.from_pretrained(id);
  const model = await AutoModel.from_pretrained(id, { dtype: dtype as never });
  return async (texts, kind) => {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 8) {
      const batch = texts.slice(i, i + 8).map((t) => kind === 'query' ? `task: search result | query: ${t}` : `title: none | text: ${t}`);
      const inputs = await tok(batch, { padding: true, truncation: true, max_length: 1024 });
      const { sentence_embedding } = await model(inputs);
      out.push(...rows(sentence_embedding).map((v) => norm(v.slice(0, dims) as Float32Array)));
    }
    return out;
  };
};

// Model2Vec: a static table, mean of token rows (no transformer).
const potion = (id: string) => async (): Promise<Embed> => {
  const base = `https://huggingface.co/${id}/resolve/main`;
  const buf = Buffer.from(await (await fetch(`${base}/model.safetensors`)).arrayBuffer());
  const hl = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + hl).toString());
  const key = Object.keys(header).find((k) => k !== '__metadata__')!;
  const { dtype, shape, data_offsets } = header[key];
  if (dtype !== 'F32') throw new Error(dtype);
  const start = 8 + hl + data_offsets[0];
  const table = new Float32Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + 8 + hl + data_offsets[1]));
  const [, d] = shape;
  (globalThis as never as { potionBytes: number }).potionBytes = buf.length;
  const tok = await AutoTokenizer.from_pretrained(id);
  return async (texts) => texts.map((t) => {
    const ids = tok.encode(t, { add_special_tokens: false }) as number[];
    const v = new Float32Array(d);
    for (const i of ids) for (let j = 0; j < d; j++) v[j] += table[i * d + j];
    return norm(v);
  });
};

const MODELS: Model[] = [
  { name: 'all-MiniLM-L6-v2 q8', id: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8', make: pipe('Xenova/all-MiniLM-L6-v2', 'q8', 'mean') },
  { name: 'bge-small-en-v1.5 q8', id: 'Xenova/bge-small-en-v1.5', dtype: 'q8', make: pipe('Xenova/bge-small-en-v1.5', 'q8', 'cls', 'Represent this sentence for searching relevant passages: ') },
  { name: 'bge-small-en-v1.5 fp32', id: 'Xenova/bge-small-en-v1.5', dtype: 'fp32', make: pipe('Xenova/bge-small-en-v1.5', 'fp32', 'cls', 'Represent this sentence for searching relevant passages: ') },
  { name: 'granite-small-english-r2 q8', id: 'onnx-community/granite-embedding-small-english-r2-ONNX', dtype: 'q8', make: pipe('onnx-community/granite-embedding-small-english-r2-ONNX', 'q8', 'cls') },
  { name: 'bge-base-en-v1.5 q8', id: 'Xenova/bge-base-en-v1.5', dtype: 'q8', make: pipe('Xenova/bge-base-en-v1.5', 'q8', 'cls', 'Represent this sentence for searching relevant passages: ') },
  { name: 'embeddinggemma-300m q4', id: 'onnx-community/embeddinggemma-300m-ONNX', dtype: 'q4', make: gemma('q4') },
  { name: 'embeddinggemma-300m q4 d256', id: 'onnx-community/embeddinggemma-300m-ONNX', dtype: 'q4', make: gemma('q4', 256) },
  { name: 'embeddinggemma-300m q4 d128', id: 'onnx-community/embeddinggemma-300m-ONNX', dtype: 'q4', make: gemma('q4', 128) },
  { name: 'embeddinggemma-300m q8', id: 'onnx-community/embeddinggemma-300m-ONNX', dtype: 'q8', make: gemma('q8') },
  { name: 'potion-retrieval-32M (static)', id: 'minishlab/potion-retrieval-32M', make: potion('minishlab/potion-retrieval-32M') },
];

function dirBytes(dir: string): number {
  let n = 0;
  try { for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? dirBytes(join(dir, e.name)) : statSync(join(dir, e.name)).size; } catch { /* none */ }
  return n;
}
const dtypeFile = (dtype?: string) => dtype === 'fp32' ? /^model\.onnx/ : dtype === 'q8' ? /^model_(quantized)\.onnx/ : dtype === 'q4' ? /^model_q4\.onnx/ : /x^/;
function modelBytes(m: Model): number {
  const dir = join(CACHE, m.id, 'onnx');
  try { return readdirSync(dir).filter((f) => dtypeFile(m.dtype).test(f)).reduce((n, f) => n + statSync(join(dir, f)).size, 0); } catch { return 0; }
}

const docs = vaultDocuments([...SEARCH_VAULT, ...EVAL_DISTRACTORS]);
const index = new LocalSearchIndex();
await index.addAll(docs.map((d) => ({ id: d.id, title: d.title, body: d.text, tags: d.tags, headings: d.headings, updatedAt: d.updatedAt })));
const chunks = docs.flatMap((d) => chunkNote(d.title, d.sections).map((c) => ({ note: d.id, text: c.text })));
const sets = [{ name: 'concept', q: SEARCH_EVAL }, { name: 'keyword', q: SEARCH_EVAL_KEYWORDS }];
const words = (q: string) => index.search(parseQuery(q), { limit: 50 });

// Words-only baseline.
{
  let top = 0, rr = 0;
  for (const s of sets) for (const { query, expected } of s.q) {
    const r = words(query).findIndex((h) => h.id === expected);
    if (r >= 0 && r < 5) top++; if (r >= 0) rr += 1 / (r + 1);
  }
  console.log(`WORDS-ONLY (LocalSearchIndex) all top-5 ${top}/50 MRR ${(rr / 50).toFixed(3)}`);
}
console.log(`chunks: ${chunks.length}, avg chars ${Math.round(chunks.reduce((n, c) => n + c.text.length, 0) / chunks.length)}`);

const only = process.argv[2];
for (const m of MODELS.filter((x) => !only || x.name.includes(only))) {
  try {
    const rss0 = process.memoryUsage().rss;
    let t = performance.now();
    const embed = await m.make();
    await embed(['warm up'], 'query');
    const load = performance.now() - t;
    t = performance.now();
    const vecs = await embed(chunks.map((c) => c.text), 'doc');
    const indexMs = performance.now() - t;
    const rss = process.memoryUsage().rss - rss0;
    const meaning = async (q: string) => {
      const [qv] = await embed([q], 'query');
      const best = new Map<string, number>();
      vecs.forEach((v, i) => { let s = 0; for (let j = 0; j < v.length; j++) s += v[j] * qv[j]; const n = chunks[i].note; if ((best.get(n) ?? -2) < s) best.set(n, s); });
      return [...best].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, 50);
    };
    const fuse = (text: ReturnType<typeof words>, mean: { id: string; score: number }[], floor: number) => {
      const byText = new Map(text.map((h) => [h.id, h])); const byMean = new Map(mean.map((h) => [h.id, h]));
      const fused = reciprocalRankFusion([text.map((h) => h.id), mean.map((h) => h.id)])
        .filter(({ id }) => byText.has(id) || (byMean.get(id)?.score ?? 0) >= floor);
      const inTitle = (id: string) => byText.get(id)?.titleHighlighted.includes(MATCH_START) ?? false;
      return [...fused.filter((f) => inTitle(f.id)), ...fused.filter((f) => !inTitle(f.id))].map((f) => f.id);
    };
    const runs: { text: ReturnType<typeof words>; mean: { id: string; score: number }[]; expected: string; set: string }[] = [];
    let qms = 0;
    for (const s of sets) for (const { query, expected } of s.q) {
      const t0 = performance.now(); const mean = await meaning(query); qms += performance.now() - t0;
      runs.push({ text: words(query), mean, expected, set: s.name });
    }
    const unrelated = await Promise.all(UNRELATED.map(meaning));
    const score = (ids: (r: (typeof runs)[number]) => string[], set?: string) => {
      let top = 0, rr = 0, n = 0;
      for (const r of runs.filter((x) => !set || x.set === set)) { n++; const k = ids(r).indexOf(r.expected); if (k >= 0 && k < 5) top++; if (k >= 0) rr += 1 / (k + 1); }
      return { top, n, mrr: rr / n };
    };
    const sem = score((r) => r.mean.map((h) => h.id));
    const semC = score((r) => r.mean.map((h) => h.id), 'concept');
    const h0 = score((r) => fuse(r.text, r.mean, -1));
    // Highest floor that keeps hybrid's top-5 count, and how many unrelated meaning hits pass it.
    let floor = -1;
    for (let f = 0; f <= 0.95; f += 0.01) { if (score((r) => fuse(r.text, r.mean, f)).top >= h0.top) floor = f; else break; }
    const hf = score((r) => fuse(r.text, r.mean, floor));
    const leak = unrelated.reduce((n, hits) => n + hits.filter((h) => h.score >= floor).length, 0);
    const labelledSims = runs.map((r) => r.mean.find((h) => h.id === r.expected)?.score ?? 0).sort((a, b) => a - b);
    const maxUnrelated = Math.max(...unrelated.map((h) => h[0]?.score ?? 0));
    const bytes = modelBytes(m) || (globalThis as never as { potionBytes?: number }).potionBytes || 0;
    console.log(JSON.stringify({
      model: m.name, mb: +(bytes / 1e6).toFixed(1), dims: vecs[0].length,
      loadMs: Math.round(load), indexChunksMs: Math.round(indexMs), msPerChunk: +(indexMs / chunks.length).toFixed(1), msPerQuery: +(qms / runs.length).toFixed(1), rssMb: Math.round(rss / 1e6),
      semantic: `${sem.top}/50 MRR ${sem.mrr.toFixed(3)} (concept ${semC.top}/30)`,
      hybrid: `${hf.top}/50 MRR ${hf.mrr.toFixed(3)}`, floor: +floor.toFixed(2), unrelatedPastFloor: leak,
      gap: `labelled min ${labelledSims[0].toFixed(3)} vs unrelated max ${maxUnrelated.toFixed(3)}`,
    }));
  } catch (e) {
    console.log(JSON.stringify({ model: m.name, error: String(e).slice(0, 300) }));
  }
}
