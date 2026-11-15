/**
 * What main checks in a git notebook's commit before it makes it, and after its push lands
 * (A855, A886, #174 delta review): a commit may delete for good only the notes the Mac's owner
 * confirmed here in the last `PURGE_TTL_MS`; it never takes back or re-adds a note already
 * deleted for good, never marks an agent's change undone from an agent's writer, and never
 * shrinks a log. Each refusal stops the sync, and nothing is pushed.
 */
import { commitPurges, commitWriter } from '@penmoss/git-notebook/purge-check';

/**
 * A Delete for good confirmed with Touch ID counts this long for a first commit to carry it; a
 * commit main let through keeps it until that push lands (in this run of the app).
 */
export const PURGE_TTL_MS = 10 * 60_000;

/** A refusal from main's own checks inside a transport call (not git's). */
export class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What a commit would delete for good, and what else it would do (`@penmoss/git-notebook`). */
export type CommitPurges = Awaited<ReturnType<typeof commitPurges>>;

/** The confirmations of one Mac's notebooks as commits use them, for this run of the app. */
export class PurgeGuard {
  /** Commits made with confirmed purges in them, until their push lands. */
  private readonly commitPurges = new Map<string, readonly string[]>();
  /** Per notebook: purges a commit main let through carried, until they land (no TTL then). */
  private readonly approved = new Map<string, Set<string>>();
  /** Per notebook: the notes main's last refused commit would have deleted for good unconfirmed. */
  private readonly refused = new Map<string, readonly string[]>();

  constructor(private readonly now: () => number) {}

  /**
   * Whether a note needs its Delete for good confirmed (again) before a commit may carry it:
   * never confirmed here (`at` undefined), or confirmed too long ago and in no commit let through.
   */
  needsConfirming(localId: string, id: string, at: number | undefined): boolean {
    if (at === undefined) return true;
    return this.now() - at >= PURGE_TTL_MS && !this.approved.get(localId)?.has(id);
  }

  /** The notes the notebook's last refused commit would have deleted for good unconfirmed. */
  lastRefused(localId: string): readonly string[] {
    return this.refused.get(localId) ?? [];
  }

  /**
   * Throws `Refused` for a commit main must not make: `confirmed` are the notebook's held
   * confirmations (`git-notebooks.json`'s `purges`), `message` the commit's (its writer).
   */
  check(
    localId: string,
    purges: CommitPurges,
    confirmed: readonly { readonly id: string; readonly at: number }[],
    message: string,
  ): void {
    if (purges.reversed.length > 0) {
      throw new Refused(
        'purge_reversed',
        `This sync would take back ${purges.reversed.length === 1 ? 'a note' : `${purges.reversed.length} notes`} already deleted for good in the repository, which would bring ${purges.reversed.length === 1 ? 'it' : 'them'} back from any device with an old copy, so nothing was pushed.`,
      );
    }
    if (purges.raced.length > 0) {
      // A copy brought back after a store was cleared whose original another device deleted
      // for good at head (A886): the engine withholds one; a page that sends one is refused.
      // The Mac never brings copies back (that is Android's), so no Keep and sync confirms one
      // here.
      throw new Refused(
        'purge_raced',
        'This sync would add a copy of a note already deleted for good in the repository, so nothing was pushed.',
      );
    }
    // Only a person's writer marks an agent's change undone (#174 delta review).
    if (purges.undoneMarks.length > 0 && commitWriter(message)?.kind === 'agent') {
      throw new Refused(
        'agent_undone',
        'This sync would mark an agent’s change undone from an agent’s writer, but only you mark an agent’s change undone, so nothing was pushed.',
      );
    }
    if (purges.shrunk.length > 0) {
      throw new Refused(
        'log_shrunk',
        'This sync would replace a log in the repository with less than it holds, which would wipe notes or folders without deleting them, so nothing was pushed.',
      );
    }
    const now = this.now();
    const ok = new Set([
      ...confirmed.filter((one) => now - one.at < PURGE_TTL_MS).map((one) => one.id),
      ...(this.approved.get(localId) ?? []),
    ]);
    const unconfirmed = [...purges.added.filter((id) => !ok.has(id)), ...purges.stray];
    if (unconfirmed.length > 0) {
      this.refused.set(localId, unconfirmed);
      throw new Refused(
        'purge_unconfirmed',
        `This sync would delete ${unconfirmed.length === 1 ? 'a note' : `${unconfirmed.length} notes`} for good that nobody confirmed on this Mac in the last ${PURGE_TTL_MS / 60_000} minutes, so nothing was pushed. Confirm Delete for good again in Settings → Notebooks (Touch ID).`,
      );
    }
    this.refused.delete(localId);
  }

  /** The commit main let through: its purges count until its push lands, whatever the time. */
  committed(localId: string, commit: string | null, added: readonly string[]): void {
    if (!commit || added.length === 0) return;
    this.commitPurges.set(commit, added);
    const approved = this.approved.get(localId) ?? new Set<string>();
    for (const id of added) approved.add(id);
    this.approved.set(localId, approved);
  }

  /** A push answered: once it landed, the purges its commit carried are spent (null: none). */
  pushed(localId: string, commit: string, outcome: string): ReadonlySet<string> | null {
    const landed = this.commitPurges.get(commit);
    if (outcome !== 'pushed' || !landed) return null;
    this.commitPurges.delete(commit);
    const spent = new Set(landed);
    for (const id of spent) this.approved.get(localId)?.delete(id);
    return spent;
  }
}
