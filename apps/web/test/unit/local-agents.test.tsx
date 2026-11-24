// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliInfo, DesktopGit, GitAnswer, LocalAgentInfo } from '../../src/desktop/bridge';
import { AgentServer, CommandLine, GitLocalAgents } from '../../src/sources/LocalAgents';

// T54 (A992, A993; PEN-155): Settings → Agents gives every agent the one local MCP server, lists
// each notebook's agent copies, and installs the penmoss command, with no account and no token.

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
});

const cliInfo = (state: CliInfo['state'], onPath: boolean | null = false): CliInfo => ({
  path: '/Users/me/.local/bin/penmoss',
  state,
  onPath,
  pathLine: 'export PATH="$HOME/.local/bin:$PATH"',
  profile: '~/.zshrc',
  direct: `${EXE} --penmoss-cli`,
  server: {
    server: 'penmoss',
    claude: `claude mcp add penmoss -- ${EXE} --penmoss-cli mcp`,
    claudeChannel: `claude mcp add penmoss -- ${EXE} --penmoss-cli mcp --channel`,
    claudeLaunch: 'claude --dangerously-load-development-channels server:penmoss',
    codex: `[mcp_servers."penmoss"]\ncommand = "${EXE}"\nargs = ["--penmoss-cli", "mcp"]`,
  },
});

/** A bridge with only the agents and command calls, recording them. */
function bridge(
  options: {
    agents?: LocalAgentInfo[];
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

describe('The MCP Server (PEN-155)', () => {
  it('gives Claude Code and Codex the one server, with the channel when asked, and asks no name', async () => {
    const { git } = bridge();
    const root = await mount(<AgentServer git={git} />);
    const command = () => find(root, 'agents-server-claude')?.querySelector('code')?.textContent;
    expect(command()).toBe(`claude mcp add penmoss -- ${EXE} --penmoss-cli mcp`);
    expect(find(root, 'agents-server-codex')?.textContent).toContain('[mcp_servers."penmoss"]');
    expect(find(root, 'agents-server-launch')).toBeNull();
    expect(root.querySelector('input:not([role="switch"])')).toBeNull();
    const toggle = find(root, 'agents-server-channel') as HTMLInputElement;
    await click(toggle);
    expect(command()).toBe(`claude mcp add penmoss -- ${EXE} --penmoss-cli mcp --channel`);
    expect(find(root, 'agents-server-launch')?.querySelector('code')?.textContent).toBe(
      'claude --dangerously-load-development-channels server:penmoss',
    );
    // Codex has no channels: its configuration is as it was.
    expect(find(root, 'agents-server-codex')?.textContent).not.toContain('--channel');
    await click(toggle);
    expect(command()).not.toContain('--channel');
  });

  it('shows nothing when main gives no server lines', async () => {
    const { path, state, onPath, pathLine, profile, direct } = cliInfo('missing');
    const { git } = bridge({ cli: { path, state, onPath, pathLine, profile, direct } });
    const root = await mount(<AgentServer git={git} />);
    expect(find(root, 'agents-server')).toBeNull();
  });
});

describe('Agent copies on this Mac (A993, PEN-155)', () => {
  it('lists the copy Penmoss made, with no Remove, and an older named copy with Remove', async () => {
    const automatic = { ...agent('Agent', 'notes-agent'), automatic: true };
    const { git } = bridge({ agents: [automatic, agent('Codex', 'notes-codex')] });
    const root = await mount(<GitLocalAgents git={git} localId="nb1" />);
    const rows = root.querySelectorAll<HTMLElement>('[data-testid="git-local-agent"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('[data-testid="git-local-agent-automatic"]')).not.toBeNull();
    expect(rows[0]!.querySelector('[data-testid="git-local-agent-remove"]')).toBeNull();
    expect(rows[1]!.querySelector('[data-testid="git-local-agent-older"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-testid="git-local-agent-remove"]')).not.toBeNull();
    // Nothing connects an agent by name any more.
    expect(find(root, 'git-local-agent-label')).toBeNull();
    expect(find(root, 'git-local-agent-connect')).toBeNull();
  });

  it('asks before losing changes an older copy has not pushed', async () => {
    const { git, calls } = bridge({
      agents: [agent('Codex', 'notes-codex')],
      disconnect: (_name, force) =>
        force
          ? { ok: true, value: null }
          : { ok: false, error: { code: 'unsynced_changes', message: 'Not pushed.' } },
    });
    const root = await mount(<GitLocalAgents git={git} localId="nb1" />);
    await settle();
    await click(find(root, 'git-local-agent-remove'));
    expect(find(root, 'git-local-agent-unsynced')?.textContent).toContain(
      '“Codex” has changes it has not pushed yet',
    );
    await click(find(root, 'git-local-agent-remove-anyway'));
    expect(calls).toEqual(
      expect.arrayContaining([
        ['disconnect', 'notes-codex', false],
        ['disconnect', 'notes-codex', true],
      ]),
    );
    expect(root.querySelectorAll('[data-testid="git-local-agent"]')).toHaveLength(0);
    expect(find(root, 'git-local-agent-message')?.textContent).toContain('Removed “Codex”');
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
