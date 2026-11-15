/**
 * A git notebook's History on this device (G6, A831, A858): a note's versions are the commits
 * that touched its logs. Saving one commits now; restoring or reverting one first saves what it
 * replaces. Agent activity (#172, A920) is read from the same commits, for the people only.
 */
import { unsupportedContent } from '@penmoss/editor/edit-engine';
import { readNoteState, UnsupportedContentError } from '@penmoss/editor/markdown';
import { revertChange } from '@penmoss/editor/revert';
import { restoreContent } from '@penmoss/sync-client/history';
import { AgentActivity, type ActivityEntry } from '../agent-activity';
import { NotebookHistory, type GitHistory, type GitVersion } from '../history';
import { LocalError, fail, type NoteCatalog } from './catalog';

/** Who a notebook is served to: the apps (the person), or the CLI and `penmoss mcp` (agents). */
export interface ServedTo {
  readonly side?: 'app' | 'cli' | 'mcp';
}

export class LocalVersions {
  private historyReader: NotebookHistory | null = null;
  private activityReader: AgentActivity | null = null;

  constructor(
    private readonly notes: NoteCatalog,
    private readonly clock: () => number,
    private readonly commitNow: (() => Promise<void>) | undefined,
    private readonly served: ServedTo,
  ) {}

  private get engine() {
    return this.notes.engine;
  }

  private get history(): NotebookHistory {
    this.historyReader ??= new NotebookHistory(this.engine.transport, this.engine.layout);
    return this.historyReader;
  }

  async versions(id: string, limit = 100): Promise<GitHistory> {
    this.notes.require(id);
    return this.history.history(id, {
      limit,
      dirtySince: this.engine.replica.state.dirty[id] ?? null,
      self: this.notes.self(),
    });
  }

  async versionDetail(id: string, version: number) {
    this.notes.require(id);
    const detail = await this.history.detail(id, version);
    if (!detail) throw new LocalError(404, 'version_not_found', 'No such version');
    return detail;
  }

  async saveVersion(
    id: string,
  ): Promise<{ id: string; version: GitVersion | null; saved: boolean }> {
    this.notes.require(id);
    const pending = this.engine.replica.state.dirty[id] !== undefined;
    if (pending && this.commitNow) await this.commitNow();
    const latest = (await this.history.history(id, { limit: 1 })).versions[0] ?? null;
    const saved = pending && this.engine.replica.state.dirty[id] === undefined;
    if (!latest && !pending) throw new LocalError(404, 'not_found', 'No such note');
    return { id, version: latest, saved };
  }

  /**
   * Before a restore or a revert, the note as it is now becomes a version: what the restore
   * replaces stays in history, so the restore itself can be undone. An edit that cannot be
   * committed (no sync here, or it did not land) refuses the restore: nothing is replaced that
   * history would not keep.
   */
  private async saveCurrentFirst(id: string): Promise<void> {
    if (this.engine.replica.state.dirty[id] === undefined) return;
    if (this.commitNow) await this.commitNow().catch(() => undefined);
    if (this.engine.replica.state.dirty[id] !== undefined) {
      throw new LocalError(
        409,
        'version_not_saved',
        'The note has changes not committed yet, and they could not be saved as a version first (sync, then try again). Nothing was changed.',
      );
    }
  }

  async restoreVersion(id: string, version: number) {
    this.notes.writable(id);
    await this.saveCurrentFirst(id);
    const { doc } = this.notes.writable(id);
    const found = await this.history.commitOf(id, version);
    if (!found) throw new LocalError(404, 'version_not_found', 'No such version');
    const old = await this.history.docAt(id, found.commit.id);
    try {
      const changed = restoreContent(doc, old);
      if (changed) this.notes.remember(id, doc);
      return { id, version: null, changed };
    } finally {
      old.destroy();
    }
  }

  async revertVersion(id: string, version: number) {
    this.notes.writable(id);
    await this.saveCurrentFirst(id);
    const { doc } = this.notes.writable(id);
    const pair = await this.history.revertPair(id, version);
    if (!pair) throw new LocalError(404, 'version_not_found', 'No such version');
    try {
      const rev = this.engine.replica.rev(id);
      let conflicts: ReturnType<typeof revertChange>['conflicts'] = [];
      try {
        doc.transact(() => {
          conflicts = revertChange(doc, pair.before, pair.after).conflicts;
        });
      } catch (error) {
        // A body to merge that this build cannot read: thrown before anything is written (A1493).
        if (error instanceof UnsupportedContentError) fail(unsupportedContent(doc));
        throw error;
      }
      const changed = this.engine.replica.rev(id) !== rev;
      if (changed) this.notes.remember(id, doc);
      return { id, version: null, changed, conflicts };
    } finally {
      pair.before.destroy();
      pair.after.destroy();
    }
  }

  // --- agent activity (#172, A920) ---

  /** For the people using the apps: an agent's writer cannot read or undo it. */
  private requirePerson(): void {
    if (this.engine.who.kind === 'agent' || (this.served.side ?? 'app') !== 'app') {
      throw new LocalError(
        403,
        'agent_not_allowed',
        'Agent activity is for the people using the apps; an agent cannot read or undo it',
      );
    }
  }

  private get activity(): AgentActivity {
    this.activityReader ??= new AgentActivity(this.engine.transport, this.engine.layout, (id) => {
      const doc = this.notes.ops.note(id);
      return doc ? readNoteState(doc).title : null;
    });
    return this.activityReader;
  }

  async agentActivity(): Promise<{ entries: ActivityEntry[] }> {
    this.requirePerson();
    return this.activity.list(this.notes.workspace, this.clock());
  }

  async undoAgentActivity(id: number) {
    this.requirePerson();
    const result = await this.activity.undo(
      this.notes.workspace,
      id,
      this.engine.who.label,
      this.clock(),
    );
    if (!result.ok) throw new LocalError(result.status, result.code, result.message);
    return { id, undone: true, alreadyUndone: result.alreadyUndone, notice: result.notice };
  }
}
