/**
 * Agents on this Mac with no account (T54, D47), in Settings → Agents (A1098; PEN-146; PEN-155):
 *
 * - **The MCP Server** (PEN-155, A1585): the one `penmoss mcp` for every notebook, with Claude
 *   Code's command (and its channel, T60, A1073) and Codex's lines, each with Copy. Nothing asks
 *   for an agent's name: each edit names its client and session (A1586).
 * - **Each notebook's agent copies** (A993, D52): the app's own copy of every notebook, which the
 *   one server uses, and older copies connected by name, which keep working with
 *   `penmoss mcp --notebook <name>` until Remove removes them.
 * - **The penmoss Command** (A992): writes `~/.local/bin/penmoss`, which runs this app as the CLI,
 *   and says how to put its folder on PATH. Installed and on PATH, it is one line with Manage…,
 *   which opens the card (PEN-146).
 */
import { copyText } from '@penmoss/editor';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useRef, useState } from 'react';
import {
  type AgentServerInfo,
  type CliInfo,
  type DesktopGit,
  type GitAnswer,
  type LocalAgentInfo,
} from '../desktop/bridge';
import { ConfirmBlock } from '../shell/ConfirmBlock';

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

/** A refusal's words, or the window's when main answered nothing. */
function said<T>(result: GitAnswer<T> | null): string | null {
  if (!result) return 'This window cannot change agents on this Mac.';
  return result.ok ? null : result.error.message;
}

/**
 * Settings → Agents → The MCP Server (PEN-155): the one server for every notebook, and how to
 * give it to Claude Code (with its channel, if wanted) and Codex.
 */
export function AgentServer({ git }: { git: DesktopGit }) {
  const id = useId();
  const [server, setServer] = useState<AgentServerInfo | null>(null);
  const [channel, setChannel] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void git.cli().then(
      (cli) => !cancelled && setServer(cli?.server ?? null),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [git]);
  if (!server) return null;
  return (
    <section
      className="settings-card"
      aria-labelledby={`${id}-h`}
      data-testid="agents-server"
      data-setting="mcp-server"
    >
      <h3 id={`${id}-h`}>
        <Icon name="agentRef" />
        The MCP Server
      </h3>
      <p>
        One server reaches every notebook on this Mac. Add it once to each agent; its edits are
        named in History by the app and session that made them.
      </p>
      <label className="local-agent-channel">
        <input
          type="checkbox"
          role="switch"
          checked={channel}
          data-testid="agents-server-channel"
          onChange={(event) => setChannel(event.target.checked)}
        />
        <span>Receive Comments Sent to Claude Code Sessions</span>
      </label>
      <CopyBlock
        label="Claude Code: Run in a Terminal"
        text={channel ? server.claudeChannel : server.claude}
        testId="agents-server-claude"
      />
      {channel ? (
        <>
          <CopyBlock
            label="Then start Claude Code with its channel"
            text={server.claudeLaunch}
            testId="agents-server-launch"
          />
          <p className="muted" data-testid="agents-server-channel-note">
            Comments you send to its session with Send to…, from any notebook, arrive in it. Added{' '}
            <code>{server.server}</code> before? Run <code>claude mcp remove {server.server}</code>{' '}
            first.
          </p>
        </>
      ) : null}
      <CopyBlock
        label="Codex: Add to ~/.codex/config.toml"
        text={server.codex}
        testId="agents-server-codex"
      />
    </section>
  );
}

export function GitLocalAgents({
  git,
  localId,
  onAgents,
}: {
  git: DesktopGit;
  localId: string;
  /** The agent copies, each time they are read. */
  onAgents?: (agents: readonly LocalAgentInfo[]) => void;
}) {
  const id = useId();
  const told = useRef(onAgents);
  useEffect(() => {
    told.current = onAgents;
  });
  const [agents, setAgents] = useState<readonly LocalAgentInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The copy with changes not pushed, after Remove. */
  const [unsynced, setUnsynced] = useState<LocalAgentInfo | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void git.agents(localId).then(
      (result) => {
        if (cancelled) return;
        if (result?.ok) {
          setAgents(result.value);
          told.current?.(result.value);
        } else {
          setAgents([]);
          setMessage(said(result));
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [git, localId, version]);

  const remove = async (agent: LocalAgentInfo, force: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await git.disconnectAgent(agent.name, force);
      if (result && !result.ok && result.error.code === 'unsynced_changes') {
        setUnsynced(agent);
        return;
      }
      setUnsynced(null);
      setMessage(
        said(result) ??
          `Removed “${agent.label}”. Remove ${agent.server} from its MCP servers too.`,
      );
      setVersion((at) => at + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="local-agents" aria-labelledby={`${id}-h`} data-testid="git-local-agents">
      <h4 id={`${id}-h`} className="sr-only">
        Agent Copies
      </h4>
      {agents && agents.length > 0 ? (
        <ul className="local-agent-list" data-testid="git-local-agent-list">
          {agents.map((agent) => (
            <li key={agent.name} data-testid="git-local-agent" data-name={agent.name}>
              <div className="local-agent-head">
                <strong>{agent.label}</strong>
                <span className="muted">
                  penmoss … --notebook <code>{agent.name}</code>
                </span>
                {agent.automatic ? (
                  <span className="muted" data-testid="git-local-agent-automatic">
                    Made by Penmoss: the MCP server reaches this notebook through it
                  </span>
                ) : (
                  <>
                    <span className="muted" data-testid="git-local-agent-older">
                      An older copy connected by name: it works with its own server until you remove
                      it
                    </span>
                    <button
                      data-ui="item"
                      type="button"
                      className="btn"
                      data-testid="git-local-agent-remove"
                      disabled={busy}
                      onClick={() => void remove(agent, false)}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
              {unsynced?.name === agent.name ? (
                <ConfirmBlock
                  className="git-remove-confirm"
                  title="Disconnect Anyway?"
                  testId="git-local-agent-unsynced"
                >
                  <p>
                    “{agent.label}” has changes it has not pushed yet: removing it now loses them.
                    Its MCP server pushes them when the agent next runs.
                  </p>
                  <div className="settings-actions">
                    <button
                      data-ui="item"
                      type="button"
                      className="btn danger"
                      data-testid="git-local-agent-remove-anyway"
                      disabled={busy}
                      onClick={() => void remove(agent, true)}
                    >
                      Remove Anyway
                    </button>
                    <button
                      data-ui="item"
                      type="button"
                      className="btn"
                      onClick={() => setUnsynced(null)}
                    >
                      Keep It
                    </button>
                  </div>
                </ConfirmBlock>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p role="status" className="muted" data-testid="git-local-agent-message">
        {message}
      </p>
    </section>
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
        agents (<code>penmoss mcp</code>). It is this app, so it needs no Node, no account and no
        agent token.
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
        <p className="muted" data-testid="git-cli-state">
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
        data-setting="the-penmoss-command"
      >
        <span className="nset-okline-mark" data-testid="git-cli-state">
          <Icon name="check" size={14} />
          penmoss Command Installed
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
      data-setting="the-penmoss-command"
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
          <p className="muted">
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
        <summary>Without the Command</summary>
        <CopyBlock label="Run the CLI As" text={cli.direct} testId="git-cli-direct" />
      </details>
      <p role="status" className="muted" data-testid="git-cli-message">
        {message}
      </p>
    </section>
  );
}
