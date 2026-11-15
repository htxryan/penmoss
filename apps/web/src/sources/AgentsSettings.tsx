/**
 * Settings → Agents (A1098; One Page, Folded in PEN-146, amending A1125), in the Mac app: how
 * agents such as Claude Code and Codex reach the git notebooks on this Mac. A page of its own,
 * not a notebook's, since the MCP server is to work across notebooks.
 *
 * - **The penmoss command** (A992): one line when it is installed and on PATH ("penmoss command
 *   installed", its path, Manage…); the full card otherwise, or once Manage… opens it.
 * - **Connected Agents** (A993, D52; A1559): each notebook a row that folds open in place, with its
 *   agents (the copy Penmoss makes for every agent, and each agent connected by name, with
 *   Disconnect and the lines to give it) and Connect an Agent… on each row.
 *   `/settings/agents/<notebook id>` opens with that notebook unfolded.
 * - What agents changed, in every notebook, is the page beside this one: Agent Activity.
 */
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useState } from 'react';
import { desktop, type DesktopGit, type LocalAgentInfo } from '../desktop/bridge';
import { linkHandler, notebookAgentsPath } from '../router';
import { GroupHead } from '../theme/look-rows';
import { mcpName } from './agent-words';
import { CommandLine, GitLocalAgents } from './LocalAgents';
import { useAllSources, useGitInfo } from './hooks';
import type { GitSource } from './git-source';
import './sources.css';
import './notebook-settings.css';
import { SettingsHeader } from '../pages/SettingsHeader';

const ACTIVITY_PATH = '/settings/agent-activity';

export function AgentsSettings({ item }: { item?: string | undefined }) {
  const git = desktop()?.git;
  const state = useAllSources();
  const id = useId();
  /** The notebooks unfolded: the one the address names, then whichever the person opens. */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(item ? [item] : []));
  // Another notebook's address while the page is open (a link, Back): it unfolds too.
  const [named, setNamed] = useState(item);
  if (named !== item) {
    setNamed(item);
    if (item && !open.has(item)) setOpen(new Set([...open, item]));
  }
  if (!git) return null;
  const sources = state.all;
  const missing = item !== undefined && !sources.some((each) => each.id === item);
  const fold = (sourceId: string, unfolded: boolean) =>
    setOpen((was) => {
      const next = new Set(was);
      if (unfolded) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
  return (
    <section
      className="settings-section nset-page"
      aria-labelledby={`${id}-h`}
      data-testid="agents-settings"
    >
      <SettingsHeader
        id={`${id}-h`}
        title="Agents"
        intro="Claude Code, Codex and other agents read and edit your notes through Penmoss on this Mac."
      />
      <CommandLine git={git} />
      <GroupHead scope>Connected Agents</GroupHead>
      {missing ? (
        <p className="muted" data-testid="agents-notebook-missing">
          That notebook isn’t on this Mac.
        </p>
      ) : null}
      {sources.length === 0 ? (
        <p className="muted">
          No notebooks on this Mac yet:{' '}
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
        <ul
          className="nset-fold-list"
          data-testid="agents-notebook-list"
          data-setting="connected-agents"
        >
          {sources.map((source) => (
            <NotebookAgentsRow
              key={source.id}
              source={source}
              git={git}
              open={open.has(source.id)}
              onFold={(unfolded) => fold(source.id, unfolded)}
            />
          ))}
        </ul>
      )}
      <p className="muted nset-pointer">
        What agents changed, in every notebook, is on{' '}
        <a
          href={ACTIVITY_PATH}
          data-ui="item"
          data-testid="agents-activity-link"
          onClick={linkHandler(ACTIVITY_PATH)}
        >
          Agent Activity
        </a>
        .
      </p>
    </section>
  );
}

/** How many agents are connected to a notebook, once main has said (null until then). */
function useAgentCount(
  git: DesktopGit,
  localId: string,
): readonly [number | null, (n: number) => void] {
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
  return [count, setCount];
}

const countWords = (agents: readonly LocalAgentInfo[] | null, count: number | null) => {
  if (agents && agents.length > 0) return agents.map((agent) => agent.label).join(', ');
  if (count === null) return '';
  return count === 0 ? 'No agents' : count === 1 ? '1 agent' : `${count} agents`;
};

/**
 * A notebook's row: its name and its agents' names, folding open in place to its agents, with
 * Connect an Agent…, which unfolds it and puts the cursor in the agent's name.
 */
function NotebookAgentsRow({
  source,
  git,
  open,
  onFold,
}: {
  source: GitSource;
  git: DesktopGit;
  open: boolean;
  onFold: (unfolded: boolean) => void;
}) {
  const info = useGitInfo(source);
  const [count, setCount] = useAgentCount(git, info.localId);
  const [agents, setAgents] = useState<readonly LocalAgentInfo[] | null>(null);
  /** Bumped by Connect an Agent…: the name field takes the focus. */
  const [connect, setConnect] = useState(0);
  const id = useId();
  return (
    <li
      data-testid="agents-notebook-row"
      data-notebook-id={source.id}
      data-path={notebookAgentsPath(source.id)}
      data-open={open ? 'true' : undefined}
    >
      <div className="nset-fold-head">
        <button
          type="button"
          className="nset-fold-toggle"
          data-ui="item"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          data-testid="agents-notebook-fold"
          onClick={() => onFold(!open)}
        >
          <Icon name={open ? 'chevD' : 'chevR'} size={14} />
          <span className="nset-fold-text">
            <span className="nset-fold-name">{info.name}</span>
            <span className="nset-fold-count" data-testid="agents-notebook-count">
              {countWords(agents, count)}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="btn"
          data-ui="item"
          data-testid="agents-connect-open"
          onClick={() => {
            onFold(true);
            setConnect((at) => at + 1);
          }}
        >
          <Icon name="plus" size={14} />
          Connect an Agent…
        </button>
      </div>
      {open ? (
        <div
          id={`${id}-body`}
          className="nset-fold-body notebook-agents"
          data-testid="notebook-agents"
          data-notebook-id={source.id}
        >
          <p className="muted">
            Agents reach it as <code>penmoss mcp --notebook {mcpName(info.name)}</code>
          </p>
          <GitLocalAgents
            git={git}
            localId={info.localId}
            focus={connect}
            onAgents={(list) => {
              setAgents(list);
              setCount(list.length);
            }}
          />
        </div>
      ) : null}
    </li>
  );
}
