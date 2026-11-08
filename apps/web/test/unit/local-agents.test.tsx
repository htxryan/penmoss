// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliInfo, DesktopGit, GitAnswer, LocalAgentInfo } from '../../src/desktop/bridge';
import { CommandLine, GitLocalAgents } from '../../src/sources/LocalAgents';

// T54 (A992, A993): Settings → Git Notebooks connects an agent on this Mac through the local MCP
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

describe('Agents on This Mac (A993)', () => {
  it('connects an agent by name and shows its Claude Code command and Codex configuration', async () => {
    const { git, calls } = bridge();
    const root = await mount(<GitLocalAgents git={git} localId="nb1" />);
    await settle();
    expect(root.querySelectorAll('[data-testid="git-local-agent"]')).toHaveLength(0);
    expect((find(root, 'git-local-agent-label') as HTMLInputElement).value).toBe('Claude Code');
    const form = find(root, 'git-local-agent-connect')!.closest('form')!;
    act(() => form.requestSubmit());
    await settle();
    expect(calls).toContainEqual(['connect', 'nb1', 'Claude Code']);
    expect(find(root, 'git-local-agent-message')?.textContent).toContain('Connected “Claude Code”');
    const listed = root.querySelectorAll('[data-testid="git-local-agent"]');
    expect(listed).toHaveLength(1);
    expect(find(root, 'git-local-agent-claude')?.textContent).toContain(
      `claude mcp add penmoss-notes-x -- ${EXE} --penmoss-cli mcp --notebook notes-x`,
    );
    expect(find(root, 'git-local-agent-codex')?.textContent).toContain(
      '[mcp_servers."penmoss-notes-x"]',
    );
  });

  it('Receive comments sent to this agent adds the channel and its launch line (T60, A1073)', async () => {
    const { git } = bridge({ agents: [agent('Claude Code', 'notes-claude-code')] });
    const root = await mount(<GitLocalAgents git={git} localId="nb1" />);
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
    // Codex has no channels: its configuration is as it was.
    expect(find(root, 'git-local-agent-codex')?.textContent).not.toContain('--channel');
    await click(toggle);
    expect(command()).not.toContain('--channel');
    expect(find(root, 'git-local-agent-launch')).toBeNull();
  });

  it('says why a connection was refused', async () => {
    const { git } = bridge({
      connect: () => ({ ok: false, error: { code: 'not_confirmed', message: 'Cancelled.' } }),
    });
    const root = await mount(<GitLocalAgents git={git} localId="nb1" />);
    const form = find(root, 'git-local-agent-connect')!.closest('form')!;
    act(() => form.requestSubmit());
    await settle();
    expect(find(root, 'git-local-agent-message')?.textContent).toBe('Cancelled.');
    expect(root.querySelectorAll('[data-testid="git-local-agent"]')).toHaveLength(0);
  });

  it('asks before losing changes an agent has not pushed', async () => {
    const { git, calls } = bridge({
      agents: [agent('Codex', 'notes-codex')],
      disconnect: (_name, force) =>
        force
          ? { ok: true, value: null }
          : { ok: false, error: { code: 'unsynced_changes', message: 'Not pushed.' } },
    });
    const root = await mount(<GitLocalAgents git={git} localId="nb1" />);
    await settle();
    await click(find(root, 'git-local-agent-disconnect'));
    expect(find(root, 'git-local-agent-unsynced')?.textContent).toContain(
      '“Codex” has changes it has not pushed yet',
    );
    await click(find(root, 'git-local-agent-disconnect-anyway'));
    expect(calls).toEqual(
      expect.arrayContaining([
        ['disconnect', 'notes-codex', false],
        ['disconnect', 'notes-codex', true],
      ]),
    );
    expect(root.querySelectorAll('[data-testid="git-local-agent"]')).toHaveLength(0);
    expect(find(root, 'git-local-agent-message')?.textContent).toContain('Disconnected “Codex”');
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
