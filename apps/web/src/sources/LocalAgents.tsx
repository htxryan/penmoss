/**
 * Agents on this Mac with no account (T54, D47), in Settings → Agents (A1098):
 *
 * - **Each notebook's agents** (A993, D52): the app's own agent clone of every notebook
 *   (“Agent”), made by itself, which every agent on this Mac can use and which goes only with
 *   the notebook; and Connect an Agent (a name, then Touch ID) makes the
 *   agent's own clone of the notebook in the CLI's `~/.penmoss`, and shows how to give it Penmoss's
 *   MCP server, which runs on this Mac from the app: Claude Code's command and Codex's
 *   configuration, each with Copy. No account and no agent token: the agent syncs through the
 *   notebook's repository, as itself. Disconnect removes its clone. "Receive comments sent to this
 *   agent" (T60, A1073) shows the Claude Code command with `--channel`, and how to start Claude
 *   Code so it loads that channel, for the threads Ryan sends it with Send to….
 * - **The penmoss Command** (A992): writes `~/.local/bin/penmoss`, which runs this app as the CLI,
 *   and says how to put its folder on PATH.
 */
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useState } from 'react';
import {
  desktop,
  type CliInfo,
  type DesktopGit,
  type GitAnswer,
  type LocalAgentInfo,
} from '../desktop/bridge';

/** Copies `text` (the click is the gesture the Mac app's clipboard needs). */
async function copy(text: string): Promise<boolean> {
  const app = desktop();
  if (app) return app.clipboard.write({ text });
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}

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
        onClick={() => void copy(text).then(setCopied)}
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

export function GitLocalAgents({ git, localId }: { git: DesktopGit; localId: string }) {
  const id = useId();
  const [agents, setAgents] = useState<readonly LocalAgentInfo[] | null>(null);
  const [label, setLabel] = useState('Claude Code');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The agent whose clone has changes not pushed, after Disconnect. */
  const [unsynced, setUnsynced] = useState<LocalAgentInfo | null>(null);
  /** The agents whose Claude Code command is shown with the channel (A1073). */
  const [channels, setChannels] = useState<ReadonlySet<string>>(new Set());
  const setChannel = (name: string, on: boolean) =>
    setChannels((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void git.agents(localId).then(
      (result) => {
        if (cancelled) return;
        if (result?.ok) setAgents(result.value);
        else {
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

  const connect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await git.connectAgent(localId, label);
      const refused = said(result);
      if (refused) setMessage(refused);
      else if (result?.ok) {
        setMessage(
          `Connected “${result.value.label}”. Give it the MCP server below, then start a new session in it.`,
        );
      }
      setVersion((at) => at + 1);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (agent: LocalAgentInfo, force: boolean) => {
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
          `Disconnected “${agent.label}”. Remove ${agent.server} from its MCP servers too.`,
      );
      setVersion((at) => at + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="local-agents" aria-labelledby={`${id}-h`} data-testid="git-local-agents">
      <h4 id={`${id}-h`} className="sr-only">
        Agents
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
                    Made by Penmoss for every agent on this Mac
                  </span>
                ) : (
                  <button
                    data-ui="item"
                    type="button"
                    className="btn"
                    data-testid="git-local-agent-disconnect"
                    disabled={busy}
                    onClick={() => void disconnect(agent, false)}
                  >
                    Disconnect
                  </button>
                )}
              </div>
              <label className="local-agent-channel">
                <input
                  type="checkbox"
                  role="switch"
                  checked={channels.has(agent.name)}
                  data-testid="git-local-agent-channel"
                  onChange={(event) => setChannel(agent.name, event.target.checked)}
                />
                <span>Receive comments sent to this agent</span>
              </label>
              <CopyBlock
                label="Claude Code: run in a terminal"
                text={channels.has(agent.name) ? agent.claudeChannel : agent.claude}
                testId="git-local-agent-claude"
              />
              {channels.has(agent.name) ? (
                <>
                  <CopyBlock
                    label="Then start Claude Code with its channel"
                    text={agent.claudeLaunch}
                    testId="git-local-agent-launch"
                  />
                  <p className="muted" data-testid="git-local-agent-channel-note">
                    Comments you send to its session with Send to… arrive in it. Added{' '}
                    <code>{agent.server}</code> before? Run{' '}
                    <code>claude mcp remove {agent.server}</code> first.
                  </p>
                </>
              ) : null}
              <CopyBlock
                label="Codex: add to ~/.codex/config.toml"
                text={agent.codex}
                testId="git-local-agent-codex"
              />
              {unsynced?.name === agent.name ? (
                <div
                  className="git-remove-confirm"
                  role="alert"
                  data-testid="git-local-agent-unsynced"
                >
                  <p>
                    “{agent.label}” has changes it has not pushed yet: disconnecting now loses them.
                    Its MCP server pushes them when the agent next runs.
                  </p>
                  <div className="settings-actions">
                    <button
                      data-ui="item"
                      type="button"
                      className="btn danger"
                      data-testid="git-local-agent-disconnect-anyway"
                      disabled={busy}
                      onClick={() => void disconnect(agent, true)}
                    >
                      Disconnect Anyway
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
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="settings-row"
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <label className="settings-field">
          <span>
            Another agent’s name <span className="muted">(its own copy, named in History)</span>
          </span>
          <input
            className="input"
            maxLength={40}
            value={label}
            data-testid="git-local-agent-label"
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="btn"
          data-ui="submit"
          data-testid="git-local-agent-connect"
          disabled={busy || label.trim() === ''}
        >
          <Icon name="key" size={14} />
          Connect an Agent
        </button>
      </form>
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
        <p className="muted" data-testid="git-cli-state">
          Checking…
        </p>
      </section>
    );
  }
  const mine = cli.state === 'installed' || cli.state === 'stale';
  return (
    <section
      className="settings-card"
      aria-labelledby={`${id}-h`}
      data-testid="git-cli"
      data-state={cli.state}
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
        <summary>Without the command</summary>
        <CopyBlock label="Run the CLI as" text={cli.direct} testId="git-cli-direct" />
      </details>
      <p role="status" className="muted" data-testid="git-cli-message">
        {message}
      </p>
    </section>
  );
}
