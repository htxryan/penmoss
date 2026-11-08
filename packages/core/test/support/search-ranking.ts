/**
 * Ranking regression fixture (T22): exact-word queries over `SEARCH_VAULT`
 * and the notes full-text search must return first, in order (bm25 with the
 * `FTS_WEIGHTS` columns). The server's D1 search and the client's offline
 * index are both held to it, so they also agree with each other.
 */
export interface RankingCase {
  readonly query: string;
  /** The first results, in order (all of them when the query finds no more). */
  readonly top: readonly string[];
}

export const RANKING_CASES: readonly RankingCase[] = [
  // Stemming: "backups" and "backup" are one term; the title outweighs the body.
  { query: 'backup', top: ['zfs-snapshots', 'offsite-backup', 'git-mirror'] },
  { query: 'backups', top: ['zfs-snapshots', 'offsite-backup', 'git-mirror'] },
  { query: 'tomato', top: ['tomatoes', 'pests'] },
  { query: 'restore', top: ['offsite-backup', 'git-mirror'] },
  { query: 'savings', top: ['budget', 'goals-2026', 'emergency-fund'] },
  { query: 'rotation', top: ['incident-review', 'car-maintenance'] },
  { query: 'kyoto', top: ['japan-trip'] },
  { query: 'knee', top: ['physio'] },
  { query: 'coffee', top: ['coffee', 'atomic-habits', 'tailscale'] },
  { query: 'garden', top: ['pests', 'watering', 'raised-beds', 'compost', 'tomatoes'] },
  // Every word must match.
  { query: 'zfs snapshot', top: ['zfs-snapshots'] },
  { query: 'drip timer', top: ['watering', 'raised-beds'] },
  // Phrases and prefixes.
  { query: '"cold ferment"', top: ['pizza-dough'] },
  { query: 'proxm*', top: ['proxmox-host'] },
  { query: 'sourd*', top: ['sourdough'] },
  // A title and a body word together.
  { query: 'neapolitan dough', top: ['pizza-dough'] },
];
