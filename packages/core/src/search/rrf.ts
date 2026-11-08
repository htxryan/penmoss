/**
 * Reciprocal rank fusion (T23): merges ranked lists (full-text and semantic)
 * by `Σ 1 / (k + rank)`. Scores never mix, so bm25 and cosine scales need no
 * calibration; k = 60 is the constant of Cormack et al. (2009).
 */
export const RRF_K = 60;

export interface Fused {
  readonly id: string;
  readonly score: number;
  /** The id's 1-based rank in each list, or null when it is not in that list. */
  readonly ranks: ReadonlyArray<number | null>;
}

export function reciprocalRankFusion(lists: ReadonlyArray<readonly string[]>, k = RRF_K): Fused[] {
  const fused = new Map<string, { score: number; ranks: Array<number | null> }>();
  lists.forEach((list, which) => {
    list.forEach((id, index) => {
      let entry = fused.get(id);
      if (!entry) {
        entry = { score: 0, ranks: lists.map(() => null) };
        fused.set(id, entry);
      }
      if (entry.ranks[which] !== null) return; // An id counts once per list, at its best rank.
      entry.ranks[which] = index + 1;
      entry.score += 1 / (k + index + 1);
    });
  });
  const firstRank = (ranks: ReadonlyArray<number | null>) => {
    const rank = ranks.find((value) => value !== null);
    return ranks.indexOf(rank ?? null) * 1e6 + (rank ?? 1e6);
  };
  return [...fused.entries()]
    .map(([id, entry]) => ({ id, score: entry.score, ranks: entry.ranks }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        firstRank(a.ranks) - firstRank(b.ranks) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
