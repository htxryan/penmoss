/**
 * Agents on this Mac with no account (T54, D47), in Settings → Agents (A1098; a table and a
 * drawer, AgentsSettings.tsx). The parts the page puts together:
 *
 * - **Each notebook's agents** (A993, D52; `useAgentLists`): the app's own agent clone of every
 *   notebook ("Any Agent"), made by itself, which every agent on this Mac can use and which goes
 *   only with the notebook; and each agent connected by name, with its own clone in the CLI's
 *   `~/.penmoss`. No account and no agent token: the agent syncs through the notebook's
 *   repository, as itself.
 * - **Connect an Agent** (`ConnectAgentForm`): which agent, which notebook, its name, then Touch
 *   ID makes the agent's own clone.
 * - **Its setup** (`AgentSetup`): how to give it Penmoss's MCP server, which runs on this Mac from
 *   the app, for Claude Code, Codex or any other client, each with Copy. "Receive Comments Sent to
 *   It" (T60, A1073) shows the Claude Code command with `--channel`, and how to start Claude Code
 *   so it loads that channel, for the threads Ryan sends it with Send to….
 * - **Disconnect…** (`DisconnectAgent`): asks, then removes its clone; asks again before losing
 *   changes it has not pushed.
 * - **The penmoss Command** (A992): writes `~/.local/bin/penmoss`, which runs this app as the CLI,
 *   and says how to put its folder on PATH. Installed and on PATH, it is one line with Manage…,
 *   which opens the card (PEN-146).
 */
import { copyText } from '@penmoss/editor';
import { Select } from '@penmoss/ui/controls/Select';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  type CliInfo,
  type DesktopGit,
  type GitAnswer,
  type LocalAgentInfo,
} from '../desktop/bridge';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { Switch } from '../theme/look-rows';
import type { GitSource } from './git-source';
import { NotebookBadge } from './NotebookBadge';
import { AGENT_CLIENTS, said, type AgentClient } from './agent-lists';

function CopyBlock({ label, text, testId }: { label: string; text: string; testId: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="local-agent-copy" data-testid={testId}>
      <span className="muted">{label}</span>
      <pre>
        <code>{text}</code>
      </pre>
      <button
        data-ui="item"
        type="button"
        className="btn"
        onClick={() => void copyText(document, text).then(setCopied)}
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} />
        {copied === null ? 'Copy' : copied ? 'Copied' : 'Select and copy it'}
      </button>
    </div>
  );
}

const CLIENT_IDS = AGENT_CLIENTS.map((each) => each.id);

/** Arrow keys, Home and End move along the tabs, as a notebook page's tabs do. */
function onTabKey(
  event: KeyboardEvent<HTMLElement>,
  at: AgentClient,
  choose: (id: AgentClient) => void,
) {
  const index = CLIENT_IDS.indexOf(at);
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  const next =
    event.key === 'Home'
      ? CLIENT_IDS[0]
      : event.key === 'End'
        ? CLIENT_IDS[CLIENT_IDS.length - 1]
        : step
          ? CLIENT_IDS[(index + step + CLIENT_IDS.length) % CLIENT_IDS.length]
          : undefined;
  if (next === undefined) return;
  event.preventDefault();
  choose(next);
  const list = event.currentTarget;
  requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-client="${next}"]`)?.focus());
}

/**
 * How to give an agent Penmoss's MCP server: a tab for each client (Claude Code's command, Codex's
 * configuration, any other client's command line), each with Copy; on Claude Code's, Receive
 * Comments Sent to It (T60, A1073), which Codex and the others have no channel for.
 */
export function AgentSetup({
  agent,
  client,
  onClient,
  channel,
  onChannel,
}: {
  agent: LocalAgentInfo;
  client: AgentClient;
  onClient: (client: AgentClient) => void;
  /** Whether its Claude Code command is shown with the channel. */
  channel: boolean;
  onChannel: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="agent-setup">
      <div
        className="nset-tabs agent-setup-tabs"
        role="tablist"
        aria-label="Set Up In"
        onKeyDown={(event) => onTabKey(event, client, onClient)}
      >
        {AGENT_CLIENTS.map((each) => (
          <button
            key={each.id}
            type="button"
            role="tab"
            id={`${id}-tab-${each.id}`}
            className="nset-tab"
            data-ui="option"
            data-client={each.id}
            data-testid={`agent-tab-${each.id}`}
            aria-selected={client === each.id}
            aria-controls={`${id}-panel`}
            tabIndex={client === each.id ? 0 : -1}
            onClick={() => onClient(each.id)}
          >
            {each.label}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        className="agent-setup-panel"
        aria-labelledby={`${id}-tab-${client}`}
      >
        {client === 'claude' ? (
          <>
            <CopyBlock
              label="Run once in a terminal:"
              text={channel ? agent.claudeChannel : agent.claude}
              testId="git-local-agent-claude"
            />
            {channel ? (
              <>
                <CopyBlock
                  label="Then start Claude Code with its channel:"
                  text={agent.claudeLaunch}
                  testId="git-local-agent-launch"
                />
                <p className="t-help" data-testid="git-local-agent-channel-note">
                  Added <code>{agent.server}</code> before? Run{' '}
                  <code>claude mcp remove {agent.server}</code> first.
                </p>
              </>
            ) : null}
          </>
        ) : client === 'codex' ? (
          <CopyBlock
            label="Add to ~/.codex/config.toml:"
            text={agent.codex}
            testId="git-local-agent-codex"
          />
        ) : (
          <CopyBlock
            label="Any other MCP client: give it this command, which serves the notebook over stdio."
            text={agent.mcp}
            testId="git-local-agent-other"
          />
        )}
      </div>
      {client === 'claude' ? (
        <div className="agent-drawer-row">
          <label className="agent-drawer-row-text" htmlFor={`${id}-channel`}>
            <span className="agent-drawer-label">Receive Comments Sent to It</span>
            <span className="t-help">
              Comments you send to its session with Send to… arrive in it.
            </span>
          </label>
          <Switch
            id={`${id}-channel`}
            checked={channel}
            data-testid="git-local-agent-channel"
            onChange={(event) => onChannel(event.target.checked)}
          />
        </div>
      ) : null}
    </div>
  );
}

const labelFor = (client: AgentClient) =>
  AGENT_CLIENTS.find((each) => each.id === client)?.label ?? '';
/** The name Connect suggests for an agent: its client's, or none for another agent. */
const nameFor = (client: AgentClient) => (client === 'other' ? '' : labelFor(client));

/**
 * Connect an Agent (A993): which agent (its name follows the choice until it is typed over),
 * which notebook, its name, then Touch ID in main makes the agent's own clone.
 */
export function ConnectAgentForm({
  git,
  sources,
  notebookId,
  onNotebook,
  onConnected,
}: {
  git: DesktopGit;
  sources: readonly GitSource[];
  /** The notebook chosen: the row the page was on, or the first. */
  notebookId: string | undefined;
  onNotebook: (id: string) => void;
  /** Connected: the notebook, the new agent, and the client chosen for its setup. */
  onConnected: (source: GitSource, agent: LocalAgentInfo, client: AgentClient) => void;
}) {
  const id = useId();
  const labelField = useRef<HTMLInputElement>(null);
  const [client, setClient] = useState<AgentClient>('claude');
  const [label, setLabel] = useState(nameFor('claude'));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // The cursor starts in the agent's name, as Connect an Agent… always put it.
  useEffect(() => {
    labelField.current?.focus();
    labelField.current?.select();
  }, []);
  const source = sources.find((each) => each.id === notebookId) ?? sources[0];
  const choose = (kind: AgentClient) => {
    if (label.trim() === '' || label === nameFor(client)) setLabel(nameFor(kind));
    setClient(kind);
  };

  const connect = async () => {
    if (!source) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await git.connectAgent(source.info.localId, label);
      const refused = said(result);
      if (refused) setMessage(refused);
      else if (result?.ok) onConnected(source, result.value, client);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="agent-connect"
      data-testid="agents-connect"
      onSubmit={(event) => {
        event.preventDefault();
        void connect();
      }}
    >
      <label className="settings-field">
        <span>Agent</span>
        <Select
          value={client}
          data-testid="agents-connect-client"
          onChange={(event) => choose(event.currentTarget.value as AgentClient)}
        >
          {AGENT_CLIENTS.map((each) => (
            <option key={each.id} value={each.id}>
              {each.id === 'other' ? 'Another Agent' : each.label}
            </option>
          ))}
        </Select>
      </label>
      {sources.length > 1 ? (
        <label className="settings-field">
          <span>Notebook</span>
          <Select
            value={source?.id ?? ''}
            data-testid="agents-connect-notebook"
            onChange={(event) => onNotebook(event.currentTarget.value)}
          >
            {sources.map((each) => (
              <option key={each.id} value={each.id}>
                {each.name}
              </option>
            ))}
          </Select>
        </label>
      ) : source ? (
        <div className="settings-field">
          <span>Notebook</span>
          <span className="agent-notebook" data-testid="agents-connect-notebook">
            <NotebookBadge source={source} size={16} decorative />
            {source.name}
          </span>
        </div>
      ) : null}
      <label className="settings-field">
        <span>Agent Name</span>
        <input
          ref={labelField}
          className="input"
          maxLength={40}
          value={label}
          aria-describedby={`${id}-label-help`}
          data-testid="git-local-agent-label"
          onChange={(event) => setLabel(event.target.value)}
        />
        <span className="t-help" id={`${id}-label-help`}>
          It gets its own copy of the notebook, and this name in History.
        </span>
      </label>
      <div className="agent-connect-actions">
        <button
          type="submit"
          className="btn primary"
          data-ui="submit"
          data-testid="git-local-agent-connect"
          disabled={busy || label.trim() === '' || !source}
        >
          <Icon name="key" size={14} />
          Connect
        </button>
        <span className="t-help">Touch ID confirms it.</span>
      </div>
      <p role="status" className="t-help" data-testid="git-local-agent-message">
        {message}
      </p>
    </form>
  );
}

/**
 * Disconnect… (A993): asks first, then removes the agent's clone. With changes it has not pushed,
 * main refuses, and the drawer says so with Disconnect Anyway (Touch ID in main) and Keep It.
 */
export function DisconnectAgent({
  git,
  agent,
  notebook,
  onDisconnected,
}: {
  git: DesktopGit;
  agent: LocalAgentInfo;
  /** The notebook's name, for "Removes its copy of <notebook> from this Mac." */
  notebook: string;
  /** Gone: what to tell the person. */
  onDisconnected: (message: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [unsynced, setUnsynced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const disconnect = async (force: boolean) => {
    setAsking(false);
    setBusy(true);
    setMessage(null);
    try {
      const result = await git.disconnectAgent(agent.name, force);
      if (result && !result.ok && result.error.code === 'unsynced_changes') {
        setUnsynced(true);
        return;
      }
      setUnsynced(false);
      const refused = said(result);
      if (refused) setMessage(refused);
      else {
        onDisconnected(
          `Disconnected “${agent.label}”. Remove ${agent.server} from its MCP servers too.`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-drawer-foot">
      <button
        data-ui="item"
        type="button"
        className="btn danger"
        data-testid="git-local-agent-disconnect"
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        Disconnect…
      </button>
      <p className="t-help">Removes its copy of {notebook} from this Mac.</p>
      {asking ? (
        <ConfirmDialog
          title={`Disconnect “${agent.label}”?`}
          testId="git-local-agent-confirm"
          onCancel={() => setAsking(false)}
          onSubmit={() => void disconnect(false)}
        >
          <p>
            Removes its copy of {notebook} from this Mac. Remove <code>{agent.server}</code> from
            its MCP servers too.
          </p>
          <div className="confirm-actions">
            <button
              type="button"
              className="btn"
              data-ui="dismiss"
              onClick={() => setAsking(false)}
              autoFocus
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn danger-fill"
              data-ui="submit"
              data-testid="git-local-agent-disconnect-confirm"
            >
              Disconnect
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
      {unsynced ? (
        <div className="git-remove-confirm" role="alert" data-testid="git-local-agent-unsynced">
          <p>
            “{agent.label}” has changes it has not pushed yet: disconnecting now loses them. Its MCP
            server pushes them when the agent next runs.
          </p>
          <div className="settings-actions">
            <button
              data-ui="item"
              type="button"
              className="btn danger"
              data-testid="git-local-agent-disconnect-anyway"
              disabled={busy}
              onClick={() => void disconnect(true)}
            >
              Disconnect Anyway
            </button>
            <button data-ui="item" type="button" className="btn" onClick={() => setUnsynced(false)}>
              Keep It
            </button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p role="alert" className="t-help" data-testid="git-local-agent-refused">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** Settings → Agents → The penmoss Command (A992, A1098). */
export function CommandLine({ git }: { git: DesktopGit }) {
  const id = useId();
  /** Undefined until main answers; null when this window cannot ask (not the main window). */
  const [cli, setCli] = useState<CliInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The card opened (Manage…, or an action taken): it stays open while the page is. */
  const [managing, setManaging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const read = () =>
      void git.cli().then(
        (value) => !cancelled && setCli(value),
        () => undefined,
      );
    read();
    // A terminal may change PATH or the file meanwhile: read again when Penmoss comes back, and
    // once more a few seconds later, when the login shell main asks again has answered (A1124).
    let again: ReturnType<typeof setTimeout> | undefined;
    const onFocus = () => {
      read();
      clearTimeout(again);
      again = setTimeout(read, 5000);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearTimeout(again);
      window.removeEventListener('focus', onFocus);
    };
  }, [git]);

  const change = async (run: () => Promise<GitAnswer<CliInfo> | null>, done: string) => {
    setBusy(true);
    setMessage(null);
    setManaging(true);
    try {
      const result = await run();
      if (result?.ok) {
        setCli(result.value);
        setMessage(done);
      } else setMessage(said(result));
    } finally {
      setBusy(false);
    }
  };

  // The card is there from the start (A1124): its words and actions fill in once main answers,
  // rather than the whole card popping in under the page's first lines.
  const head = (
    <>
      <h3 id={`${id}-h`}>
        <Icon name="terminal" />
        The penmoss Command
      </h3>
      <p>
        <code>penmoss</code> reads and edits git notebooks from a terminal, and serves them to
        agents (<code>penmoss mcp --notebook …</code>). It is this app, so it needs no Node, no
        account and no agent token.
      </p>
    </>
  );
  if (cli === null) return null;
  if (cli === undefined) {
    return (
      <section
        className="settings-card"
        aria-labelledby={`${id}-h`}
        aria-busy="true"
        data-testid="git-cli"
      >
        {head}
        <p className="t-help" data-testid="git-cli-state">
          Checking…
        </p>
      </section>
    );
  }
  const mine = cli.state === 'installed' || cli.state === 'stale';
  if (cli.state === 'installed' && cli.onPath === true && !managing) {
    // Healthy: one line, and the card behind Manage… (PEN-146).
    return (
      <div
        className="nset-okline"
        data-testid="git-cli"
        data-state={cli.state}
        data-compact="true"
        data-setting="penmoss-command"
      >
        <span className="nset-okline-mark" data-testid="git-cli-state">
          <Icon name="check" size={14} />
          penmoss command installed
        </span>
        <code className="muted">{cli.path}</code>
        <button
          data-ui="item"
          type="button"
          className="btn"
          data-testid="git-cli-manage"
          onClick={() => setManaging(true)}
        >
          Manage…
        </button>
      </div>
    );
  }
  return (
    <section
      className="settings-card"
      aria-labelledby={`${id}-h`}
      data-testid="git-cli"
      data-state={cli.state}
      data-setting="penmoss-command"
    >
      {head}
      <p data-testid="git-cli-state">
        {cli.state === 'installed'
          ? `Installed at ${cli.path}.`
          : cli.state === 'stale'
            ? `${cli.path} runs another copy of Penmoss: update it to run this one.`
            : cli.state === 'other'
              ? `${cli.path} is another program’s, so Penmoss leaves it. Move it away to install Penmoss’s.`
              : `Not installed. Install writes ${cli.path}, a short script that runs this app.`}
      </p>
      {mine && cli.onPath === false ? (
        <div data-testid="git-cli-path">
          <p className="t-help">
            Its folder is not on your terminal’s PATH yet. Add this line to {cli.profile}, then open
            a new terminal:
          </p>
          <CopyBlock label="" text={cli.pathLine} testId="git-cli-path-line" />
        </div>
      ) : null}
      {mine && cli.onPath === true ? (
        <p className="muted">
          Try <code>penmoss notebook ls</code> in a new terminal.
        </p>
      ) : null}
      <div className="settings-actions">
        {cli.state === 'other' ? null : (
          <button
            data-ui="item"
            type="button"
            className="btn primary"
            data-testid="git-cli-install"
            disabled={busy}
            onClick={() =>
              void change(
                () => git.installCli(),
                cli.state === 'missing' ? 'Installed.' : 'Updated: it runs this copy of Penmoss.',
              )
            }
          >
            <Icon name="terminal" size={14} />
            {cli.state === 'missing'
              ? 'Install Command'
              : cli.state === 'stale'
                ? 'Update Command'
                : 'Reinstall'}
          </button>
        )}
        {mine ? (
          <button
            data-ui="item"
            type="button"
            className="btn"
            data-testid="git-cli-remove"
            disabled={busy}
            onClick={() => void change(() => git.removeCli(), 'Removed.')}
          >
            Remove Command
          </button>
        ) : null}
      </div>
      <details className="local-agent-direct">
        <summary>Without the command</summary>
        <CopyBlock label="Run the CLI as" text={cli.direct} testId="git-cli-direct" />
      </details>
      <p role="status" className="t-help" data-testid="git-cli-message">
        {message}
      </p>
    </section>
  );
}
