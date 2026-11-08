/**
 * The search eval (T71, A1155, A1159), back from the deleted server: the sample vault
 * (`SEARCH_VAULT`, 59 notes) with both sets of near-duplicate distractors, searched by words
 * (`LocalSearchIndex`, as `LocalNotebook` does), by meaning (`MeaningIndex`) and in hybrid
 * (`fuseHybrid`). For each set it reports how often the labelled note is in the top 5 and the
 * mean reciprocal rank:
 *
 * - tuning: `SEARCH_EVAL` (30 concept) and `SEARCH_EVAL_KEYWORDS` (20 keyword), with `UNRELATED`
 *   (10) to choose the floor: the range between the unrelated queries' best similarity and the
 *   labelled notes' lowest, and each floor's top 5 and leaks;
 * - held out: `SEARCH_EVAL_HELD_OUT` (20) and `UNRELATED_HELD_OUT` (10), at the embedder's floor.
 *
 * Any `Embedder`: EmbeddingGemma by default (`@penmoss/embed/eval`, downloading the model into
 * PENMOSS_HOME once), `PENMOSS_EVAL_EMBEDDER=fake` for the fake one (it only measures the
 * harness), or another module whose `evalEmbedder()` returns one:
 *
 *   pnpm --filter @penmoss/git-notebook eval:search
 *   PENMOSS_EVAL_EMBEDDER=fake pnpm --filter @penmoss/git-notebook eval:search
 *
 * With a real model it asserts the targets: hybrid's top 5 for at least 48 of the 50 with MRR at
 * least 0.88 (A1159) and no worse than either side, no unrelated meaning hit past the floor, and the held-out bar.
 */
import {
  fakeEmbedder,
  fuseHybrid,
  HYBRID_DEPTH,
  MeaningIndex,
  MemoryVectorCache,
  parseQuery,
  type Embedder,
} from '@penmoss/core/search';
import { LocalSearchIndex } from '@penmoss/sync-client/local-index';
import { expect, it } from 'vitest';
import {
  EVAL_DISTRACTORS,
  HELD_OUT_DISTRACTORS,
  SEARCH_EVAL,
  SEARCH_EVAL_HELD_OUT,
  SEARCH_EVAL_KEYWORDS,
  UNRELATED,
  UNRELATED_HELD_OUT,
  type LabelledQuery,
} from '../../core/test/support/search-eval';
import { SEARCH_VAULT } from '../../core/test/support/search-vault';
import { vaultDocuments } from '../../core/test/support/search-vault-docs';

const TOP = 5;
/** The bar on the 50 tuning queries (A1159): hybrid's top 5 for at least 48, MRR at least 0.88. */
const TARGET_TOP = 48;
const TARGET_MRR = 0.88;
/** Held-out bar (A1159): at least 16 of the 20 in hybrid's top 5. */
const HELD_OUT_TARGET = 16;
const FLOORS = [0, 0.15, 0.2, 0.25, 0.28, 0.3, 0.35, 0.4, 0.45, 0.5];
const MODES = ['words', 'meaning', 'hybrid'] as const;
type Mode = (typeof MODES)[number];

async function loadEmbedder(): Promise<{ embedder: Embedder; real: boolean }> {
  const spec = process.env['PENMOSS_EVAL_EMBEDDER'] || '@penmoss/embed/eval';
  if (spec === 'fake') return { embedder: fakeEmbedder(), real: false };
  const module = (await import(/* @vite-ignore */ spec)) as {
    evalEmbedder(): Promise<Embedder> | Embedder;
  };
  return { embedder: await module.evalEmbedder(), real: true };
}

it('finds the labelled note in hybrid’s top 5 and keeps unrelated queries out', async () => {
  const { embedder, real } = await loadEmbedder();
  const documents = vaultDocuments([...SEARCH_VAULT, ...EVAL_DISTRACTORS, ...HELD_OUT_DISTRACTORS]);
  const words = new LocalSearchIndex();
  for (const doc of documents) {
    words.add({
      id: doc.id,
      title: doc.title,
      body: doc.text,
      tags: doc.tags,
      headings: doc.headings,
      updatedAt: doc.updatedAt,
    });
  }
  const meaning = new MeaningIndex(embedder, new MemoryVectorCache());
  const started = Date.now();
  const coverage = await meaning.update(
    documents.map((doc) => ({
      id: doc.id,
      version: doc.updatedAt,
      title: doc.title,
      sections: doc.sections,
    })),
  );
  const indexMs = Date.now() - started;
  const chunks = meaning.index.keys().size;

  const search = async (query: string) => {
    const text = words.search(parseQuery(query, { prefixLast: false }), { limit: HYBRID_DEPTH });
    const found = await meaning.search(query);
    return { text, found };
  };
  type Tally = Record<Mode, { top: number; reciprocal: number }>;
  const tally = (): Tally => ({
    words: { top: 0, reciprocal: 0 },
    meaning: { top: 0, reciprocal: 0 },
    hybrid: { top: 0, reciprocal: 0 },
  });
  const count = (into: { top: number; reciprocal: number }, rank: number) => {
    if (rank >= 1 && rank <= TOP) into.top++;
    if (rank >= 1) into.reciprocal += 1 / rank;
  };
  const show = (rank: number) => (rank === 0 ? '—' : String(rank)).padStart(3);

  const lines: string[] = [];
  /** The labelled note's similarity, per tuning query (where meaning found it). */
  const labelledScores: number[] = [];
  const floors = new Map(FLOORS.map((floor) => [floor, { top: 0, reciprocal: 0 }]));
  const runSet = async (name: string, queries: readonly LabelledQuery[], tuning: boolean) => {
    const counts = tally();
    lines.push(
      `-- ${name} queries (words, meaning, hybrid rank; — not in the top ${HYBRID_DEPTH})`,
    );
    for (const { query, expected } of queries) {
      const { text, found } = await search(query);
      const ranked: Record<Mode, string[]> = {
        words: text.map((hit) => hit.id),
        meaning: found.map((hit) => hit.id),
        hybrid: fuseHybrid(text, found, embedder.floor).map((hit) => hit.id),
      };
      const ranks = MODES.map((mode) => ranked[mode].indexOf(expected) + 1);
      MODES.forEach((mode, i) => count(counts[mode], ranks[i]!));
      if (tuning) {
        const labelled = found.find((hit) => hit.id === expected);
        if (labelled) labelledScores.push(labelled.score);
        for (const [floor, into] of floors)
          count(
            into,
            fuseHybrid(text, found, floor)
              .map((hit) => hit.id)
              .indexOf(expected) + 1,
          );
      }
      lines.push(`${ranks.map(show).join(' ')}  ${query} → ${expected}`);
    }
    return counts;
  };
  const concept = await runSet('concept', SEARCH_EVAL, true);
  const keyword = await runSet('keyword', SEARCH_EVAL_KEYWORDS, true);
  const heldOut = await runSet('held-out', SEARCH_EVAL_HELD_OUT, false);
  const n = SEARCH_EVAL.length + SEARCH_EVAL_KEYWORDS.length;
  const all = tally();
  for (const mode of MODES) {
    all[mode].top = concept[mode].top + keyword[mode].top;
    all[mode].reciprocal = concept[mode].reciprocal + keyword[mode].reciprocal;
  }

  /** Unrelated queries: each one's best similarity, and its meaning-only hits past `floor`. */
  const unrelated = async (queries: readonly string[]) => {
    const rows: Array<{ query: string; best: number; leaks: (floor: number) => number }> = [];
    for (const query of queries) {
      const { text, found } = await search(query);
      const inText = new Set(text.map((hit) => hit.id));
      const only = found.filter((hit) => !inText.has(hit.id));
      rows.push({
        query,
        best: found[0]?.score ?? 0,
        leaks: (floor) => only.filter((hit) => hit.score >= floor).length,
      });
    }
    return rows;
  };
  const tuneUnrelated = await unrelated(UNRELATED);
  const heldUnrelated = await unrelated(UNRELATED_HELD_OUT);
  const leaks = (rows: typeof tuneUnrelated, floor: number) =>
    rows.reduce((sum, row) => sum + row.leaks(floor), 0);

  const sorted = [...labelledScores].sort((a, b) => a - b);
  const unrelatedMax = Math.max(...tuneUnrelated.map((row) => row.best));
  const summary = (name: string, counts: Tally, total: number) =>
    MODES.map(
      (mode) =>
        `${name.padEnd(9)} ${mode.padEnd(8)} top ${TOP}: ${counts[mode].top}/${total} (${((counts[mode].top / total) * 100).toFixed(1)}%), MRR ${(counts[mode].reciprocal / total).toFixed(3)}`,
    );
  const unrelatedLines = (title: string, rows: typeof tuneUnrelated) => [
    `-- ${title} (best similarity; meaning-only hits at the floor ${embedder.floor})`,
    ...rows.map((row) => `  ${row.best.toFixed(3)}  ${row.query}  (${row.leaks(embedder.floor)})`),
  ];
  console.log(
    [
      `Search eval: ${documents.length} notes, ${chunks} chunks, indexed ${coverage.indexed}/${coverage.total} in ${(indexMs / 1000).toFixed(1)} s`,
      `Embedder: ${embedder.model}, ${embedder.dimensions} dimensions, floor ${embedder.floor}${real ? '' : ' (fake: it measures the harness only)'}`,
      ...lines,
      ...summary('concept', concept, SEARCH_EVAL.length),
      ...summary('keyword', keyword, SEARCH_EVAL_KEYWORDS.length),
      ...summary('tuning', all, n),
      ...summary('held-out', heldOut, SEARCH_EVAL_HELD_OUT.length),
      ...unrelatedLines('unrelated queries (tuning)', tuneUnrelated),
      ...unrelatedLines('unrelated queries (held out)', heldUnrelated),
      `-- the floor (A1155; this embedder's: ${embedder.floor})`,
      `  labelled note's similarity: min ${sorted[0]?.toFixed(3)}, 5th ${sorted[4]?.toFixed(3)}, median ${sorted[Math.floor(sorted.length / 2)]?.toFixed(3)}`,
      `  unrelated best: max ${unrelatedMax.toFixed(3)}; a floor separates them when it is in (${unrelatedMax.toFixed(3)}, ${sorted[0]?.toFixed(3)}]`,
      ...FLOORS.map((floor) => {
        const counts = floors.get(floor)!;
        return `  floor ${floor.toFixed(2)}: hybrid top ${TOP} ${counts.top}/${n}, MRR ${(counts.reciprocal / n).toFixed(3)}; unrelated leaks ${leaks(tuneUnrelated, floor)}, held-out leaks ${leaks(heldUnrelated, floor)}`;
      }),
    ].join('\n'),
  );

  expect(coverage).toEqual({ indexed: documents.length, total: documents.length });
  if (real) {
    expect(all.hybrid.top).toBeGreaterThanOrEqual(TARGET_TOP);
    expect(all.hybrid.reciprocal / n).toBeGreaterThanOrEqual(TARGET_MRR);
    expect(all.hybrid.top).toBeGreaterThanOrEqual(all.words.top);
    expect(all.hybrid.top).toBeGreaterThanOrEqual(all.meaning.top);
    expect(leaks(tuneUnrelated, embedder.floor)).toBe(0);
    expect(heldOut.hybrid.top).toBeGreaterThanOrEqual(HELD_OUT_TARGET);
    expect(leaks(heldUnrelated, embedder.floor)).toBe(0);
  }
});
