/**
 * Settings → Agent Activity (PEN-146; A920's list, moved off a notebook's page): what agents
 * changed in every git notebook on this Mac, in one list, newest first, with filters for the
 * notebook and the agent and Undo on each. Each notebook's list is read from its branch on this
 * Mac (offline too), the last 30 days of its folders, note places and settings; an agent's edits
 * to notes and their tags are in each note's History. Undo is this Mac's own change, which the
 * next sync pushes; changed again since, it says what and changes nothing.
 */
import { Select } from '@penmoss/ui/controls/Select';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useState } from 'react';
import { gitUndoMessage, type ActivityEntry } from '../agents/activity';
import { desktop } from '../desktop/bridge';
import { shortWhen } from '../shell/when';
import type { GitSource } from './git-source';
import { useAllSources } from './hooks';
import {
  EVERY,
  activityAgents,
  filterActivity,
  mergeActivity,
  type NotebookActivity,
} from './agent-activity-list';
import './notebook-settings.css';

const keyOf = (item: NotebookActivity) => `${item.notebookId}:${item.entry.id}`;

export function AgentActivitySettings() {
  const git = desktop()?.git;
  const state = useAllSources();
  const id = useId();
  const sources = state.all;
  const [lists, setLists] = useState<Record<string, readonly ActivityEntry[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const [notebook, setNotebook] = useState(EVERY);
  const [agent, setAgent] = useState(EVERY);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    for (const source of sources) {
      source
        .agentActivity()
        .then((entries) => {
          if (cancelled) return;
          setLists((was) => ({ ...was, [source.id]: entries }));
          setErrors((was) => {
            if (!(source.id in was)) return was;
            const rest = { ...was };
            delete rest[source.id];
            return rest;
          });
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setErrors((was) => ({
            ...was,
            [source.id]: caught instanceof Error ? caught.message : String(caught),
          }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [sources, version]);

  if (!git) return null;

  const read = sources.filter((source) => lists[source.id] !== undefined);
  const items = mergeActivity(
    read.map((source) => ({
      notebookId: source.id,
      notebook: source.name,
      entries: lists[source.id]!,
    })),
  );
  const agents = activityAgents(items);
  const shown = filterActivity(
    items,
    sources.some((source) => source.id === notebook) ? notebook : EVERY,
    agents.includes(agent) ? agent : EVERY,
  );
  const reading = sources.some(
    (source) => lists[source.id] === undefined && errors[source.id] === undefined,
  );
  const failed = sources.filter((source) => errors[source.id] !== undefined);

  async function undo(source: GitSource, item: NotebookActivity) {
    setBusy(keyOf(item));
    setStatus(null);
    try {
      setStatus(gitUndoMessage(await source.undoAgentActivity(item.entry.id), item.entry));
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
      setVersion((at) => at + 1);
    }
  }

  return (
    <section
      className="settings-section nset-page nset-activity"
      aria-labelledby={`${id}-h`}
      data-testid="agent-activity-settings"
    >
      <div className="nset-title">
        <h2 id={`${id}-h`}>Agent Activity</h2>
        <div className="nset-filters" data-setting="agent-activity-filters">
          {sources.length > 1 ? (
            <Select
              aria-label="Notebook"
              size="small"
              value={notebook}
              data-testid="agent-activity-notebook"
              onChange={(event) => setNotebook(event.currentTarget.value)}
            >
              <option value={EVERY}>All Notebooks</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Select
            aria-label="Agent"
            size="small"
            value={agents.includes(agent) ? agent : EVERY}
            data-testid="agent-activity-agent"
            onChange={(event) => setAgent(event.currentTarget.value)}
          >
            <option value={EVERY}>All Agents</option>
            {agents.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <p className="muted">
        What agents changed in your notebooks’ folders, note places and settings in the last 30
        days, read from each notebook’s branch on this Mac. Undo is your own change, pushed with the
        next sync. An agent’s edits to notes and their tags are in each note’s History.
      </p>
      <p role="status" className="git-message muted" data-testid="agent-activity-status">
        {status}
      </p>
      {failed.map((source) => (
        <p key={source.id} role="alert" className="muted" data-testid="agent-activity-error">
          {source.name}: {errors[source.id]}
        </p>
      ))}
      {sources.length === 0 ? (
        <p className="muted" data-testid="agent-activity-empty">
          No notebooks on this Mac yet.
        </p>
      ) : shown.length === 0 ? (
        <p className="muted" data-testid="agent-activity-empty">
          {reading
            ? 'Reading the branches…'
            : items.length === 0
              ? 'No agent has moved notes or changed folders or settings in the last 30 days.'
              : 'No change matches these filters.'}
        </p>
      ) : (
        <ul className="trash-list" aria-label="Agent activity" data-testid="agent-activity-list">
          {shown.map((item) => {
            const source = sources.find((each) => each.id === item.notebookId);
            const key = keyOf(item);
            const label = `agent-activity-${item.notebookId}-${item.entry.id}`;
            return (
              <li
                key={key}
                className="trash-item"
                data-activity-id={item.entry.id}
                data-notebook-id={item.notebookId}
                data-undone={item.entry.undoneAt ? 'true' : undefined}
              >
                <div className="trash-info">
                  <span className="trash-title" id={label}>
                    {item.entry.summary}
                  </span>
                  <span className="muted">
                    ✦ {item.entry.actor.label} · {item.notebook} · {shortWhen(item.entry.at)}
                    {item.entry.undoneAt
                      ? ` · Undone${item.entry.undoneBy ? ` by ${item.entry.undoneBy}` : ''} ${shortWhen(item.entry.undoneAt)}`
                      : ''}
                  </span>
                </div>
                {item.entry.undoneAt || !source ? null : (
                  <div className="trash-actions">
                    <button
                      type="button"
                      className="btn"
                      data-ui="item"
                      disabled={busy !== null}
                      aria-describedby={label}
                      onClick={() => void undo(source, item)}
                    >
                      <Icon name="undo" />
                      Undo
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
