import { Icon } from '@penmoss/ui/icons';
import { useEffect, useState } from 'react';
import { ActivityList } from '../agents/AgentActivity';
import { gitUndoMessage, type ActivityEntry } from '../agents/activity';
import type { GitSource } from './git-source';

/**
 * A git notebook's Agent activity in Settings → Notebooks (#172, A920): what its agents (a
 * CLI or MCP writer added with `--agent`) changed in its folders, note places and settings in the
 * last 30 days, read from the branch on this Mac, offline too, each with Undo. Undo is your own
 * change, which the next sync pushes; changed again since, it says what and changes nothing. An
 * agent's edits to notes, their tags and Trash moves are in each note's History.
 */
export function GitAgentActivity({ source }: { readonly source: GitSource }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    source
      .agentActivity()
      .then((listed) => {
        if (cancelled) return;
        setEntries(listed);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [source, open, version]);

  async function undo(entry: ActivityEntry) {
    setBusy(entry.id);
    setStatus(null);
    try {
      setStatus(gitUndoMessage(await source.undoAgentActivity(entry.id), entry));
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
      setVersion((at) => at + 1);
    }
  }

  return (
    <div className="agent-activity" data-testid="git-agent-activity">
      <button
        data-ui="item"
        type="button"
        className="btn"
        aria-expanded={open}
        data-testid="git-agent-activity-open"
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="undo" size={14} />
        Agent Activity
      </button>
      {open ? (
        <>
          <p className="muted">
            What agents changed in this notebook’s folders, note places and settings in the last 30
            days, read from its branch. Undo is your own change, pushed with the next sync. An
            agent’s edits to notes and their tags are in each note’s History.
          </p>
          {status ? (
            <p role="status" className="muted" data-testid="agent-activity-status">
              {status}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="muted" data-testid="agent-activity-error">
              {error}
            </p>
          ) : entries === null ? (
            <p className="muted">Reading the branch…</p>
          ) : (
            <ActivityList
              entries={entries}
              busy={busy}
              onUndo={(entry) => void undo(entry)}
              empty="No agent has moved notes or changed folders or settings here in the last 30 days."
            />
          )}
        </>
      ) : null}
    </div>
  );
}
