/**
 * Settings → Agents (Ryan's feedback, 5 Nov 2026; A1098), in the Mac app: how agents such as
 * Claude Code and Codex reach the git notebooks on this Mac, out of Notebooks' own pages.
 *
 * - **The penmoss Command** (A992): the CLI, which is this app, on the terminal's PATH.
 * - **Each notebook's agents** (A993, D52): the agent copy the app makes of every notebook by
 *   itself, so `penmoss mcp --notebook <its name>` serves it, and any agent connected by name.
 *   A list of the notebooks, each opening a page of its own with its agents, as Notebooks has
 *   it (Quanta feedback 2, item 5; A1125): with several notebooks, every notebook's agents on one
 *   page were too much at once.
 */
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useState } from 'react';
import { desktop, type DesktopGit } from '../desktop/bridge';
import { gitNotebookPath, linkHandler, notebookAgentsPath } from '../router';
import { mcpName } from './agent-words';
import { CommandLine, GitLocalAgents } from './LocalAgents';
import { useAllSources, useGitInfo } from './hooks';
import type { GitSource } from './git-source';
import './sources.css';

const AGENTS_PATH = '/settings/agents';

export function AgentsSettings({ item }: { item?: string | undefined }) {
  const git = desktop()?.git;
  const state = useAllSources();
  const id = useId();
  if (!git || !state) return null;
  const sources = state.all;
  if (item !== undefined) {
    const source = sources.find((each) => each.id === item);
    return (
      <section
        className="settings-section"
        aria-labelledby={`${id}-h`}
        data-testid="agents-settings"
      >
        <a
          href={AGENTS_PATH}
          data-ui="item"
          className="back-link git-notebook-back"
          data-testid="agents-back"
          onClick={linkHandler(AGENTS_PATH)}
        >
          <Icon name="arrowL" size={14} />
          Agents
        </a>
        {source ? (
          <NotebookAgents key={source.id} source={source} git={git} headingId={`${id}-h`} />
        ) : (
          <>
            <h2 id={`${id}-h`}>Agents</h2>
            <p className="muted" data-testid="agents-notebook-missing">
              That notebook isn’t on this Mac.
            </p>
          </>
        )}
      </section>
    );
  }
  return (
    <section className="settings-section" aria-labelledby={`${id}-h`} data-testid="agents-settings">
      <h2 id={`${id}-h`}>Agents</h2>
      <p>
        Agents such as Claude Code and Codex reach your git notebooks through Penmoss’s MCP server,
        which runs on this Mac from this app: no account and no agent token. Every notebook has an
        agent copy of its own, made by Penmoss, so <code>penmoss mcp --notebook</code> and the
        notebook’s name serve it to any agent, as Copy Agent Reference says.
      </p>
      <CommandLine git={git} />
      <h3 className="agents-list-heading">Notebooks</h3>
      {sources.length === 0 ? (
        <p className="muted">
          No git notebooks on this Mac yet:{' '}
          <a
            href="/settings/git-notebooks"
            data-command="app.gitNotebooks"
            onClick={linkHandler('/settings/git-notebooks')}
          >
            add one
          </a>
          .
        </p>
      ) : (
        <ul className="git-notebook-list" data-testid="agents-notebook-list">
          {sources.map((source) => (
            <NotebookAgentsRow key={source.id} source={source} git={git} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** How many agents are connected to a notebook, once main has said (null until then). */
function useAgentCount(git: DesktopGit, localId: string): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void git.agents(localId).then(
      (result) => {
        if (!cancelled) setCount(result?.ok ? result.value.length : 0);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [git, localId]);
  return count;
}

/** A notebook in the list: its name, the name agents reach it by, and its agents (A1125). */
function NotebookAgentsRow({ source, git }: { source: GitSource; git: DesktopGit }) {
  const info = useGitInfo(source);
  const count = useAgentCount(git, info.localId);
  const path = notebookAgentsPath(source.id);
  return (
    <li>
      <a
        href={path}
        data-ui="item"
        className="git-notebook-row"
        data-testid="agents-notebook-row"
        data-notebook-id={source.id}
        onClick={linkHandler(path)}
      >
        <Icon name="notebook" />
        <span className="git-notebook-row-text">
          <span className="git-notebook-row-name">{info.name}</span>
          <span className="git-notebook-row-repo muted">
            <code>penmoss mcp --notebook {mcpName(info.name)}</code>
          </span>
        </span>
        <span className="git-notebook-row-state" data-testid="agents-notebook-count">
          {count === null
            ? ''
            : count === 0
              ? 'No agents connected'
              : count === 1
                ? '1 agent connected'
                : `${count} agents connected`}
        </span>
        <Icon name="chevR" size={14} />
      </a>
    </li>
  );
}

/** One notebook's agents, on its own page: the MCP command, and Connect an Agent. */
function NotebookAgents({
  source,
  git,
  headingId,
}: {
  source: GitSource;
  git: DesktopGit;
  headingId: string;
}) {
  const info = useGitInfo(source);
  const path = gitNotebookPath(source.id);
  return (
    <article
      className="notebook-agents"
      aria-labelledby={headingId}
      data-testid="notebook-agents"
      data-notebook-id={source.id}
    >
      <h2 id={headingId}>
        <Icon name="notebook" />
        {info.name}
      </h2>
      <p className="muted">
        <code>penmoss mcp --notebook {mcpName(info.name)}</code> ·{' '}
        <a href={path} data-ui="item" data-testid="agents-notebook-git" onClick={linkHandler(path)}>
          Its git notebook settings
        </a>
      </p>
      <GitLocalAgents git={git} localId={info.localId} />
    </article>
  );
}
