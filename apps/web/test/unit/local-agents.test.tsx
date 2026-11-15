// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliInfo, DesktopGit, GitAnswer, LocalAgentInfo } from '../../src/desktop/bridge';
import type { GitSource } from '../../src/sources/git-source';
import {
  AgentSetup,
  CommandLine,
  ConnectAgentForm,
  DisconnectAgent,
} from '../../src/sources/LocalAgents';
import type { AgentClient } from '../../src/sources/agent-lists';

// T54 (A992, A993): Settings → Agents connects an agent on this Mac through the local MCP
// server, and installs the penmoss command, with no account and no agent token.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXE = '/Applications/Penmoss.app/Contents/MacOS/Penmoss';

const agent = (label: string, name: string): LocalAgentInfo => ({
  name,
  label,
  server: `penmoss-${name}`,
  claude: `claude mcp add penmoss-${name} -- ${EXE} --penmoss-cli mcp --notebook ${name}`,
  claudeChannel: `claude mcp add penmoss-${name} -- ${EXE} --penmoss-cli mcp --notebook ${name} --channel`,
  claudeLaunch: `claude --dangerously-load-development-channels server:penmoss-${name}`,
  codex: `[mcp_servers."penmoss-${name}"]\ncommand = "${EXE}"`,
  mcp: `${EXE} --penmoss-cli mcp --notebook ${name}`,
});

const cliInfo = (state: CliInfo['state'], onPath: boolean | null = false): CliInfo => ({
  path: '/Users/me/.local/bin/penmoss',
  state,
  onPath,
  pathLine: 'export PATH="$HOME/.local/bin:$PATH"',
  profile: '~/.zshrc',
  direct: `${EXE} --penmoss-cli`,
});

/** A bridge with only the agents and command calls, recording them. */
function bridge(
  options: {
    agents?: LocalAgentInfo[];
    connect?: (label: string) => GitAnswer<LocalAgentInfo>;
    disconnect?: (name: string, force: boolean) => GitAnswer<null>;
    cli?: CliInfo;
  } = {},
) {
  const calls: unknown[][] = [];
  let agents = [...(options.agents ?? [])];
  let cli = options.cli ?? cliInfo('missing');
  const git = {
    agents: (localId: string) => {
      calls.push(['agents', localId]);
      return Promise.resolve({ ok: true, value: agents });
    },
    connectAgent: (localId: string, label: string) => {
      calls.push(['connect', localId, label]);
      const answer = options.connect?.(label) ?? { ok: true, value: agent(label, 'notes-x') };
      if (answer.ok) agents = [...agents, answer.value];
      return Promise.resolve(answer);
    },
    disconnectAgent: (name: string, force: boolean) => {
      calls.push(['disconnect', name, force]);
      const answer = options.disconnect?.(name, force) ?? { ok: true, value: null };
      if (answer.ok) agents = agents.filter((each) => each.name !== name);
      return Promise.resolve(answer);
    },
    cli: () => Promise.resolve(cli),
    installCli: () => {
      calls.push(['install']);
      cli = cliInfo('installed', false);
      return Promise.resolve({ ok: true, value: cli });
    },
    removeCli: () => {
      calls.push(['remove']);
      cli = cliInfo('missing');
      return Promise.resolve({ ok: true, value: cli });
    },
  } as unknown as DesktopGit;
  return { git, calls };
}

let host: HTMLElement | null = null;
let unmount: (() => void) | null = null;
afterEach(() => {
  if (unmount) act(unmount);
  unmount = null;
  host?.remove();
  host = null;
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
async function mount(element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  unmount = () => root.unmount();
  await settle();
  return host;
}

const find = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (element: HTMLElement | null) => {
  if (!element) throw new Error('not found');
  act(() => element.click());
  await settle();
};

/** A notebook as the connect form sees it: its name, its local id and its badge's settings. */
const notebook = (id: string, name: string) =>
  ({
    id,
    name,
    kind: 'git',
    info: { localId: `local-${id}`, name },
    onInfo: () => () => undefined,
    workspace: { settings: () => ({}), subscribe: () => () => undefined },
  }) as unknown as GitSource;

describe('Agents on This Mac (A993)', () => {
  it('Connect an Agent: its name, then Touch ID, in the notebook chosen', async () => {
    const { git, calls } = bridge();
    const sources = [notebook('A', 'Personal'), notebook('B', 'Work')];
    const connected: [string, string, string][] = [];
    let chosen = 'A';
    const root = await mount(
      <ConnectAgentForm
        git={git}
        sources={sources}
        notebookId={chosen}
        onNotebook={(id) => (chosen = id)}
        onConnected={(source, agent, client) => connected.push([source.id, agent.label, client])}
      />,
    );
    const name = find(root, 'git-local-agent-label') as HTMLInputElement;
    // The cursor starts in the agent's name, Claude Code until it is changed.
    expect(document.activeElement).toBe(name);
    expect(name.value).toBe('Claude Code');
    // Choosing Codex names it Codex, as nobody typed over the name.
    const client = find(root, 'agents-connect-client') as HTMLSelectElement;
    act(() => {
      client.value = 'codex';
      client.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(name.value).toBe('Codex');
    const pick = find(root, 'agents-connect-notebook') as HTMLSelectElement;
    expect([...pick.options].map((option) => option.textContent)).toEqual(['Personal', 'Work']);
    act(() => name.closest('form')!.requestSubmit());
    await settle();
    expect(calls).toContainEqual(['connect', 'local-A', 'Codex']);
    expect(connected).toEqual([['A', 'Codex', 'codex']]);
  });

  it('says why a connection was refused', async () => {
    const { git } = bridge({
      connect: () => ({ ok: false, error: { code: 'not_confirmed', message: 'Cancelled.' } }),
    });
    const connected: unknown[] = [];
    const root = await mount(
      <ConnectAgentForm
        git={git}
        sources={[notebook('A', 'Personal')]}
        notebookId="A"
        onNotebook={() => undefined}
        onConnected={(...args) => connected.push(args)}
      />,
    );
    // One notebook: named, with no choice to make.
    expect(find(root, 'agents-connect-notebook')?.tagName).toBe('SPAN');
    act(() => find(root, 'git-local-agent-connect')!.closest('form')!.requestSubmit());
    await settle();
    expect(find(root, 'git-local-agent-message')?.textContent).toBe('Cancelled.');
    expect(connected).toEqual([]);
  });

  it('shows the setup for Claude Code, Codex and any other client, each with Copy', async () => {
    const shown = agent('Claude Code', 'notes-claude-code');
    function Setup() {
      const [client, setClient] = useState<AgentClient>('claude');
      const [channel, setChannel] = useState(false);
      return (
        <AgentSetup
          agent={shown}
          client={client}
          onClient={setClient}
          channel={channel}
          onChannel={setChannel}
        />
      );
    }
    const root = await mount(<Setup />);
    const code = (id: string) => find(root, id)?.querySelector('code')?.textContent;
    expect(code('git-local-agent-claude')).toBe(shown.claude);
    expect(find(root, 'git-local-agent-claude')?.querySelector('button')?.textContent).toBe('Copy');
    await click(find(root, 'agent-tab-codex'));
    expect(find(root, 'agent-tab-codex')?.getAttribute('aria-selected')).toBe('true');
    expect(code('git-local-agent-codex')).toBe(shown.codex);
    // Codex has no channel: no switch on its tab.
    expect(find(root, 'git-local-agent-channel')).toBeNull();
    await click(find(root, 'agent-tab-other'));
    expect(code('git-local-agent-other')).toBe(shown.mcp);
  });

  it('Receive Comments Sent to It adds the channel and its launch line (T60, A1073)', async () => {
    const shown = agent('Claude Code', 'notes-claude-code');
    function Setup() {
      const [channel, setChannel] = useState(false);
      return (
        <AgentSetup
          agent={shown}
          client="claude"
          onClient={() => undefined}
          channel={channel}
          onChannel={setChannel}
        />
      );
    }
    const root = await mount(<Setup />);
    const command = () => find(root, 'git-local-agent-claude')?.querySelector('code')?.textContent;
    const toggle = find(root, 'git-local-agent-channel') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(command()).toBe(
      `claude mcp add penmoss-notes-claude-code -- ${EXE} --penmoss-cli mcp --notebook notes-claude-code`,
    );
    expect(find(root, 'git-local-agent-launch')).toBeNull();
    await click(toggle);
    expect(toggle.checked).toBe(true);
    expect(command()).toBe(
      `claude mcp add penmoss-notes-claude-code -- ${EXE} --penmoss-cli mcp --notebook notes-claude-code --channel`,
    );
    expect(find(root, 'git-local-agent-launch')?.querySelector('code')?.textContent).toBe(
      'claude --dangerously-load-development-channels server:penmoss-notes-claude-code',
    );
    expect(find(root, 'git-local-agent-channel-note')?.textContent).toContain(
      'claude mcp remove penmoss-notes-claude-code',
    );
    await click(toggle);
    expect(command()).not.toContain('--channel');
    expect(find(root, 'git-local-agent-launch')).toBeNull();
  });

  it('Disconnect… asks first, then asks again before losing changes not pushed', async () => {
    const { git, calls } = bridge({
      agents: [agent('Codex', 'notes-codex')],
      disconnect: (_name, force) =>
        force
          ? { ok: true, value: null }
          : { ok: false, error: { code: 'unsynced_changes', message: 'Not pushed.' } },
    });
    const told: string[] = [];
    const root = await mount(
      <DisconnectAgent
        git={git}
        agent={agent('Codex', 'notes-codex')}
        notebook="Notes"
        onDisconnected={(message) => told.push(message)}
      />,
    );
    expect(root.textContent).toContain('Removes its copy of Notes from this Mac.');
    await click(find(root, 'git-local-agent-disconnect'));
    // Nothing yet: the confirm first.
    expect(calls).toEqual([]);
    const confirm = find(root, 'git-local-agent-confirm')!;
    expect(confirm.textContent).toContain('Disconnect “Codex”?');
    act(() => confirm.querySelector('form')!.requestSubmit());
    await settle();
    expect(find(root, 'git-local-agent-unsynced')?.textContent).toContain(
      '“Codex” has changes it has not pushed yet',
    );
    await click(find(root, 'git-local-agent-disconnect-anyway'));
    expect(calls).toEqual([
      ['disconnect', 'notes-codex', false],
      ['disconnect', 'notes-codex', true],
    ]);
    expect(told).toEqual([
      'Disconnected “Codex”. Remove penmoss-notes-codex from its MCP servers too.',
    ]);
  });
});

describe('The penmoss Command (A992)', () => {
  it('installs the command and gives the PATH line when its folder is not on PATH', async () => {
    const { git, calls } = bridge();
    const root = await mount(<CommandLine git={git} />);
    await settle();
    expect(find(root, 'git-cli')?.dataset['state']).toBe('missing');
    expect(find(root, 'git-cli-install')?.textContent).toBe('Install Command');
    await click(find(root, 'git-cli-install'));
    expect(calls).toContainEqual(['install']);
    expect(find(root, 'git-cli')?.dataset['state']).toBe('installed');
    expect(find(root, 'git-cli-path')?.textContent).toContain('~/.zshrc');
    expect(find(root, 'git-cli-path-line')?.textContent).toContain(
      'export PATH="$HOME/.local/bin:$PATH"',
    );
    await click(find(root, 'git-cli-remove'));
    expect(find(root, 'git-cli')?.dataset['state']).toBe('missing');
  });

  it('offers to update a script for another copy of the app, and leaves another program’s', async () => {
    const stale = bridge({ cli: cliInfo('stale', true) });
    const root = await mount(<CommandLine git={stale.git} />);
    await settle();
    expect(find(root, 'git-cli-install')?.textContent).toBe('Update Command');
    expect(find(root, 'git-cli-path')).toBeNull();
    act(() => unmount!());
    unmount = null;
    const other = bridge({ cli: cliInfo('other') });
    const again = await mount(<CommandLine git={other.git} />);
    await settle();
    expect(find(again, 'git-cli-install')).toBeNull();
    expect(find(again, 'git-cli-remove')).toBeNull();
    expect(find(again, 'git-cli-state')?.textContent).toContain('another program’s');
    expect(find(again, 'git-cli-direct')?.textContent).toContain(`${EXE} --penmoss-cli`);
  });
});
