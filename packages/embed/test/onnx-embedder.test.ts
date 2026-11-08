import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import { dot } from '@penmoss/core/search';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOnnxEmbedder, type OnnxEmbedder } from '../src/onnx-embedder';
import { TINY, TINY_DIR } from './support';

/** The tiny graph's table: row i is ((4i + j) mod 7) − 3. */
const row = (id: number) => [0, 1, 2, 3].map((j) => ((4 * id + j) % 7) - 3);
const tokenizer = new Tokenizer(
  JSON.parse(readFileSync(join(TINY_DIR, 'tokenizer.json'), 'utf8')) as object,
  JSON.parse(readFileSync(join(TINY_DIR, 'tokenizer_config.json'), 'utf8')) as object,
);
/** What the graph should answer for `text`: the mean of its tokens' rows, normalised. */
function expected(text: string, maxTokens = TINY.maxTokens): number[] {
  let ids = tokenizer.encode(text).ids;
  if (ids.length > maxTokens) ids = [...ids.slice(0, maxTokens - 1), ids[ids.length - 1]!];
  const sum = [0, 0, 0, 0];
  for (const id of ids) row(id).forEach((v, j) => (sum[j]! += v));
  const mean = sum.map((v) => v / ids.length);
  const norm = Math.hypot(...mean);
  return mean.map((v) => v / norm);
}
const close = (actual: Float32Array, want: number[]) => {
  expect(actual).toHaveLength(want.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 5));
};

let embedder: OnnxEmbedder;
beforeAll(async () => {
  embedder = await createOnnxEmbedder({ dir: TINY_DIR, manifest: TINY, threads: 1, batch: 2 });
});
afterAll(() => embedder.dispose());

describe('the ONNX embedder (A1152)', () => {
  it('names the model with its revision, dimensions and prompts', () => {
    expect(embedder.model).toBe('tiny@01234567/4/p1');
    expect(embedder.dimensions).toBe(4);
    expect(embedder.floor).toBe(0.5);
  });

  it('adds the query and document prompts and normalises', async () => {
    const query = await embedder.embedQuery('sourdough');
    close(query, expected('task search result query sourdough'));
    expect(dot(query, query)).toBeCloseTo(1, 5);
    const [doc] = await embedder.embedDocuments(['sourdough']);
    close(doc!, expected('title none text sourdough'));
  });

  it('batches texts of different lengths and answers in the order given', async () => {
    const texts = ['dns', 'sourdough starter', 'vlan backup dns', 'starter', 'backup'];
    const vectors = await embedder.embedDocuments(texts);
    vectors.forEach((vector, i) => close(vector, expected(`title none text ${texts[i]}`)));
    // Padding changes nothing: each alone gives the same vector.
    for (const [i, text] of texts.entries())
      close((await embedder.embedDocuments([text]))[0]!, [...vectors[i]!]);
  });

  it('cuts long texts to the model’s limit, keeping the closing token', async () => {
    const long = 'sourdough starter vlan backup dns sourdough starter';
    close((await embedder.embedDocuments([long]))[0]!, expected(`title none text ${long}`));
  });

  it('runs one batch at a time when called at once', async () => {
    const all = await Promise.all(['dns', 'vlan', 'backup'].map((t) => embedder.embedQuery(t)));
    all.forEach((v, i) =>
      close(v, expected(`task search result query ${['dns', 'vlan', 'backup'][i]}`)),
    );
    expect(await embedder.embedDocuments([])).toEqual([]);
  });
});
