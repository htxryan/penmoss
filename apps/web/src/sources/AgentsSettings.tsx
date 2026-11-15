/**
 * Settings → Agents (A1098; One Page in PEN-146, amending A1125; a table and a drawer since
 * A1578), in the Mac app: the agents on this Mac that reach its git notebooks. A page of its
 * own, not a notebook's, since the MCP server is to work across notebooks.
 *
 * - **The header:** the title with **+ Connect an Agent…**, which opens the drawer on the
 *   connect form (which agent, which notebook, its name, Touch ID).
 * - **Connected Agents:** one table, a row per agent per notebook: each notebook's "Any Agent"
 *   (the copy Penmoss makes for every agent, D52) and each agent connected by name, with its
 *   notebook's badge and when it was last used. A row opens its drawer: its setup for Claude
 *   Code, Codex or another client, Receive Comments Sent to It, its server's name, and
 *   Disconnect… (not for Any Agent). `/settings/agents/<notebook id>` opens with that notebook's
 *   Any Agent in the drawer.
 * - **The penmoss command** (A992): one line when it is installed and on PATH; the full card
 *   otherwise, or once Manage… opens it.
 * - What agents changed, in every notebook, is the page beside this one: Agent Activity.
 *
 * The drawer is an `aside` at the window's right edge under Settings' bar; on a narrow window it
 * covers the page. Focus goes into it as it opens, and Esc or × closes it and gives focus back to
 * the row (or the button) that opened it.
 */
import { Icon } from '@penmoss/ui/icons';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { ActivityEntry } from '../agents/activity';
import { desktop, type DesktopGit, type LocalAgentInfo } from '../desktop/bridge';
import { linkHandler, notebookAgentsPath } from '../router';
import { agentName, lastUsed, mcpName, statusWords } from './agent-words';
import { AgentSetup, CommandLine, ConnectAgentForm, DisconnectAgent } from './LocalAgents';
import { useAgentLists, type AgentClient, type AgentList } from './agent-lists';
import { NotebookBadge } from './NotebookBadge';
import { useAllSources } from './hooks';
import type { GitSource } from './git-source';
import './sources.css';
import './notebook-settings.css';
import { SettingsHeader } from '../pages/SettingsHeader';

const ACTIVITY_PATH = '/settings/agent-activity';

export function AgentsSettings({ item }: { item?: string | undefined }) {
  const git = desktop()?.git;
  if (!git) return null;
  return <AgentsPage git={git} item={item} />;
}

/**
 * What the drawer shows: an agent's setup, or the connect form; and what opened it, which gets the
 * focus back when it closes (none when the address opened it, or Connect moved on to the agent).
 */
type Opened = { readonly from: HTMLElement | null } & (
  | {
      readonly kind: 'agent';
      readonly sourceId: string;
      readonly name: string;
      /** Just connected: shown until the list is read again, with what to do next. */
      readonly fresh?: LocalAgentInfo;
      readonly notice?: string;
    }
  | { readonly kind: 'connect'; readonly sourceId: string | undefined }
);

/** A row of the table. */
interface Row {
  readonly key: string;
  readonly source: GitSource;
  readonly agent: LocalAgentInfo;
}

const rowKey = (sourceId: string, name: string) => `${sourceId}:${name}`;

function AgentsPage({ git, item }: { git: DesktopGit; item: string | undefined }) {
  const state = useAllSources();
  const sources = state.all;
  useInfoChanges(sources);
  const id = useId();
  const drawerId = `${id}-drawer`;
  const { lists, reload } = useAgentLists(
    git,
    sources.map((source) => source.info.localId),
  );
  const activity = useActivity(sources);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Each agent's Claude Code command with the channel (A1073), by its clone's name. */
  const [channels, setChannels] = useState<ReadonlySet<string>>(new Set());
  const [client, setClient] = useState<AgentClient>('claude');
  const connectButton = useRef<HTMLButtonElement>(null);
  const table = useRef<HTMLUListElement>(null);

  // The notebook the address names opens with its Any Agent in the drawer, once it is read; and
  // another notebook's address while the page is open (a link, Back) does too.
  const [named, setNamed] = useState(item);
  const [pending, setPending] = useState(item);
  if (named !== item) {
    setNamed(item);
    setPending(item);
  }
  const missing = item !== undefined && !sources.some((each) => each.id === item);
  if (pending !== undefined) {
    const source = sources.find((each) => each.id === pending);
    const list = source ? lists[source.info.localId] : undefined;
    if (!source || list) {
      setPending(undefined);
      const agents = list?.agents ?? [];
      const agent = agents.find((each) => each.automatic) ?? agents[0];
      if (source && agent) {
        setOpened({ kind: 'agent', sourceId: source.id, name: agent.name, from: null });
      }
    }
  }

  const rows: Row[] = sources.flatMap((source) => {
    const agents = lists[source.info.localId]?.agents ?? [];
    // Each agent connected by name, then the copy every agent shares.
    return [
      ...agents.filter((each) => !each.automatic),
      ...agents.filter((each) => each.automatic),
    ].map((agent) => ({ key: rowKey(source.id, agent.name), source, agent }));
  });
  const selected = opened?.kind === 'agent' ? rowKey(opened.sourceId, opened.name) : null;
  const shown =
    opened?.kind === 'agent'
      ? (rows.find((row) => row.key === selected) ??
        (opened.fresh
          ? (() => {
              const source = sources.find((each) => each.id === opened.sourceId);
              return source ? { key: selected!, source, agent: opened.fresh } : null;
            })()
          : null))
      : null;

  // An agent gone from its notebook's list (disconnected elsewhere, the notebook removed) takes
  // its drawer with it.
  if (opened?.kind === 'agent' && !shown && lists[localIdOf(sources, opened.sourceId)]) {
    setOpened(null);
  }

  const open = (next: Opened) => {
    setNotice(null);
    if (next.kind === 'agent' && (opened?.kind !== 'agent' || opened.name !== next.name)) {
      setClient('claude');
    }
    setOpened(next);
  };
  const close = (focus?: HTMLElement | null) => {
    const row =
      selected !== null
        ? table.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(selected)}"]`)
        : null;
    const from = opened?.from;
    const back =
      focus !== undefined ? focus : from?.isConnected ? from : (row ?? connectButton.current);
    setOpened(null);
    back?.focus();
  };

  return (
    <section
      className="settings-section nset-page agents-page"
      aria-labelledby={`${id}-h`}
      data-testid="agents-settings"
      data-drawer={opened ? 'open' : undefined}
    >
      <SettingsHeader
        id={`${id}-h`}
        title="Agents"
        intro="Agents on this Mac that can read and edit your notes."
        actions={
          <button
            ref={connectButton}
            type="button"
            className="btn primary"
            data-ui="item"
            data-testid="agents-connect-open"
            aria-expanded={opened?.kind === 'connect'}
            aria-controls={opened ? drawerId : undefined}
            disabled={sources.length === 0}
            onClick={(event) =>
              open({
                kind: 'connect',
                sourceId: opened?.kind === 'agent' ? opened.sourceId : state.journal?.id,
                from: event.currentTarget,
              })
            }
          >
            <Icon name="plus" size={14} />
            Connect an Agent…
          </button>
        }
      />
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
        <div className="agents-table" data-setting="connected-agents" data-testid="agents-table">
          <div className="agents-table-row agents-table-head" aria-hidden="true">
            <span>Agent</span>
            <span>Notebook</span>
            <span>Status</span>
            <span />
          </div>
          <ul ref={table} aria-label="Connected agents" data-testid="agents-table-rows">
            {sources.map((source) => (
              <NotebookRows
                key={source.id}
                source={source}
                list={lists[source.info.localId]}
                rows={rows.filter((row) => row.source === source)}
                activity={activity[source.id] ?? []}
                selected={selected}
                drawerId={drawerId}
                onOpen={(row, from) =>
                  open({ kind: 'agent', sourceId: row.source.id, name: row.agent.name, from })
                }
              />
            ))}
          </ul>
        </div>
      )}
      <p className="t-help agents-table-help">
        “Any Agent” is the copy Penmoss keeps of each notebook for every agent on this Mac. Connect
        one by name to give it its own copy and its own name in History.
      </p>
      <p role="status" className="t-help" data-testid="agents-notice">
        {notice}
      </p>
      <CommandLine git={git} />
      <p className="muted nset-pointer">
        What agents changed is on{' '}
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
      {opened?.kind === 'connect' ? (
        <Drawer
          id={drawerId}
          label="Connect an Agent"
          title="Connect an Agent"
          subtitle="Gives an agent its own copy of a notebook and its own name in History."
          focusKey="connect"
          onClose={() => close()}
        >
          <ConnectAgentForm
            git={git}
            sources={sources}
            notebookId={opened.sourceId}
            onNotebook={(sourceId) => setOpened({ ...opened, sourceId })}
            onConnected={(source, agent, chosen) => {
              reload(source.info.localId);
              setClient(chosen);
              setOpened({
                kind: 'agent',
                from: null,
                sourceId: source.id,
                name: agent.name,
                fresh: agent,
                notice: `Connected “${agent.label}”. Give it the MCP server below, then start a new session in it.`,
              });
            }}
          />
        </Drawer>
      ) : shown ? (
        <Drawer
          id={drawerId}
          label={`${agentName(shown.agent)} on ${shown.source.name}`}
          title={
            <>
              {agentName(shown.agent)}
              {shown.agent.automatic ? <span className="chip">Shared</span> : null}
            </>
          }
          subtitle={
            <>
              <NotebookBadge source={shown.source} size={16} decorative />
              {shown.source.name} ·{' '}
              {shown.agent.automatic ? 'shared by every agent on this Mac' : 'its own copy'} · named
              “{shown.agent.label}” in History
            </>
          }
          focusKey={shown.key}
          onClose={() => close()}
        >
          {opened?.kind === 'agent' && opened.notice ? (
            <p role="status" className="agents-drawer-notice" data-testid="git-local-agent-message">
              {opened.notice}
            </p>
          ) : null}
          <div
            className="agents-drawer-body"
            data-testid="git-local-agent"
            data-name={shown.agent.name}
          >
            <AgentSetup
              agent={shown.agent}
              client={client}
              onClient={setClient}
              channel={channels.has(shown.agent.name)}
              onChannel={(on) =>
                setChannels((was) => {
                  const next = new Set(was);
                  if (on) next.add(shown.agent.name);
                  else next.delete(shown.agent.name);
                  return next;
                })
              }
            />
            <div className="agent-drawer-fact">
              <span className="agent-drawer-label">Server Name</span>
              <code data-testid="git-local-agent-server">{shown.agent.server}</code>
            </div>
            {shown.agent.automatic ? (
              <>
                <div className="agent-drawer-fact" data-testid="git-local-agent-notebook-name">
                  <span className="agent-drawer-label">By the Notebook’s Name</span>
                  <span className="t-help">
                    Any agent reaches this copy as{' '}
                    <code>penmoss mcp --notebook {mcpName(shown.source.name)}</code>
                  </span>
                </div>
                <p className="t-help agent-drawer-foot" data-testid="git-local-agent-automatic">
                  Made by Penmoss for every agent on this Mac. It goes with the notebook.
                </p>
              </>
            ) : (
              <DisconnectAgent
                key={shown.key}
                git={git}
                agent={shown.agent}
                notebook={shown.source.name}
                onDisconnected={(message) => {
                  reload(shown.source.info.localId);
                  close(connectButton.current);
                  setNotice(message);
                }}
              />
            )}
          </div>
        </Drawer>
      ) : null}
    </section>
  );
}

const localIdOf = (sources: readonly GitSource[], sourceId: string) =>
  sources.find((each) => each.id === sourceId)?.info.localId ?? '';

/** One notebook's rows: its agents, or a line saying why there are none yet. */
function NotebookRows({
  source,
  list,
  rows,
  activity,
  selected,
  drawerId,
  onOpen,
}: {
  source: GitSource;
  list: AgentList | undefined;
  rows: readonly Row[];
  activity: readonly ActivityEntry[];
  selected: string | null;
  drawerId: string;
  onOpen: (row: Row, from: HTMLElement) => void;
}) {
  const notebook = (
    <span className="agents-cell-notebook">
      <NotebookBadge source={source} size={16} decorative />
      <span className="agents-cell-text">{source.name}</span>
    </span>
  );
  if (!list) {
    return (
      <li className="agents-table-row agents-table-quiet" data-path={notebookAgentsPath(source.id)}>
        <span className="muted">Reading…</span>
        {notebook}
        <span />
        <span />
      </li>
    );
  }
  if (rows.length === 0) {
    return (
      <li
        className="agents-table-row agents-table-quiet"
        data-testid="agents-row-empty"
        data-notebook-id={source.id}
        data-path={notebookAgentsPath(source.id)}
      >
        <span className="muted">{list.error ?? 'No agents yet'}</span>
        {notebook}
        <span />
        <span />
      </li>
    );
  }
  return (
    <>
      {rows.map((row) => {
        const status = statusWords(lastUsed(activity, row.agent.label));
        const used = status !== 'Ready';
        const open = selected === row.key;
        return (
          <li key={row.key}>
            <button
              type="button"
              className="agents-table-row agents-row"
              data-ui="item"
              data-testid="agents-row"
              data-row-key={row.key}
              data-notebook-id={source.id}
              data-name={row.agent.name}
              data-automatic={row.agent.automatic ? 'true' : undefined}
              data-path={notebookAgentsPath(source.id)}
              data-selected={open ? 'true' : undefined}
              aria-expanded={open}
              aria-controls={open ? drawerId : undefined}
              onClick={(event) => onOpen(row, event.currentTarget)}
            >
              <span className="agents-cell-agent">
                <span className="agents-cell-text">{agentName(row.agent)}</span>
                {row.agent.automatic ? <span className="chip">Shared</span> : null}
              </span>
              {notebook}
              <span
                className="agents-cell-status"
                data-used={used ? 'true' : undefined}
                data-testid="agents-row-status"
              >
                {used ? <span className="agents-dot" aria-hidden="true" /> : null}
                {status}
              </span>
              <Icon name="chevR" size={14} />
            </button>
          </li>
        );
      })}
    </>
  );
}

/**
 * The drawer: an `aside` at the window's right edge, from under Settings' bar to the bottom (the
 * whole width on a narrow window). Focus goes into it as it opens, or as it shows another agent;
 * Esc closes it, unless a dialog of its own (Disconnect's confirm) has the key.
 */
function Drawer({
  id,
  label,
  title,
  subtitle,
  focusKey,
  onClose,
  children,
}: {
  id: string;
  label: string;
  title: ReactNode;
  subtitle: ReactNode;
  /** What it shows: focus goes into it again when this changes. */
  focusKey: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const top = useBelowSettingsBar();
  useEffect(() => {
    const aside = ref.current;
    // The connect form puts the cursor in its name field first.
    if (!aside || aside.contains(document.activeElement)) return;
    aside.querySelector<HTMLElement>('[data-drawer-focus]')?.focus();
  }, [focusKey]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest('dialog')) return;
    event.preventDefault();
    onClose();
  };
  return (
    <aside
      ref={ref}
      id={id}
      className="agents-drawer"
      aria-label={label}
      data-testid="agents-drawer"
      style={{ '--agents-drawer-top': `${top}px` } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <div className="agents-drawer-head">
        <div className="agents-drawer-heading">
          <h3 className="agents-drawer-title" tabIndex={-1} data-drawer-focus>
            {title}
          </h3>
          <p className="t-help agents-drawer-sub" data-testid="agents-drawer-sub">
            {subtitle}
          </p>
        </div>
        <button
          type="button"
          className="icon-btn"
          data-ui="dismiss"
          aria-label="Close"
          data-tip="Close"
          data-testid="agents-drawer-close"
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {children}
    </aside>
  );
}

/** Where the drawer starts: just under Settings' bar, wherever the page has scrolled. */
function useBelowSettingsBar(): number {
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const bar = document.querySelector('.settings-bar');
      setTop(Math.max(0, Math.round(bar?.getBoundingClientRect().bottom ?? 0)));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, []);
  return top;
}

/** Renders again when any notebook's name or settings change (a rename shows at once). */
function useInfoChanges(sources: readonly GitSource[]): void {
  const [, bump] = useReducer((at: number) => at + 1, 0);
  useEffect(() => {
    const offs = sources.map((source) => source.onInfo(bump));
    return () => {
      for (const off of offs) off();
    };
  }, [sources]);
}

/** Each notebook's Agent Activity, read once as the page opens: when each agent last used it. */
function useActivity(sources: readonly GitSource[]): Readonly<Record<string, ActivityEntry[]>> {
  const [lists, setLists] = useState<Readonly<Record<string, ActivityEntry[]>>>({});
  useEffect(() => {
    let cancelled = false;
    for (const source of sources) {
      source.agentActivity().then(
        (entries) => {
          if (!cancelled) setLists((was) => ({ ...was, [source.id]: entries }));
        },
        // No activity to read: its agents say Ready.
        () => undefined,
      );
    }
    return () => {
      cancelled = true;
    };
  }, [sources]);
  return lists;
}
