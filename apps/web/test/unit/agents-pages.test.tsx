// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../../src/agents/activity';
import type { CliInfo, DesktopGit, LocalAgentInfo } from '../../src/desktop/bridge';
import { AgentActivitySettings } from '../../src/sources/AgentActivitySettings';
import { AgentsSettings } from '../../src/sources/AgentsSettings';
import { NotebookNavEntries } from '../../src/sources/NotebookNavEntries';
import { SourcesContext } from '../../src/sources/hooks';
import type { Source, Sources, SourcesState } from '../../src/sources/registry';

// PEN-146: Settings → Agents is one page, each notebook folding open in place; Agent Activity
// lists every notebook's agent changes together; each notebook has its own entry in the nav.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = '01JB00000000000000000000AA';
const B = '01JB00000000000000000000BB';

const agent = (label: string, name: string): LocalAgentInfo => ({
  name,
  label,
  server: `penmoss-${name}`,
  claude: `claude mcp add penmoss-${name}`,
  claudeChannel: `claude mcp add penmoss-${name} --channel`,
  claudeLaunch: `claude server:penmoss-${name}`,
  codex: `[mcp_servers."penmoss-${name}"]`,
  automatic: false,
});

const entry = (id: number, at: number, label: string, summary: string): ActivityEntry => ({
  id,
  at,
  actor: { id: `agent:${label}`, label },
  kinds: ['folder.create'],
  summary,
  undoneAt: null,
  undoneBy: null,
});

function notebook(
  id: string,
  name: string,
  phase: 'synced' | 'stopped',
  activity: ActivityEntry[],
  undone: number[],
) {
  const status = { phase, pending: [], lastSyncAt: Date.now(), closing: false };
  return {
    id,
    name,
    kind: 'git',
    info: { localId: `local-${id}`, name },
    onInfo: () => () => undefined,
    // Its own settings, which its badge (PEN-140) reads: none set, so the default.
    workspace: { settings: () => ({}), subscribe: () => () => undefined },
    feed: { subscribe: () => () => undefined, status, shown: status },
    agentActivity: () => Promise.resolve(activity),
    undoAgentActivity: (entryId: number) => {
      undone.push(entryId);
      return Promise.resolve({ ok: true, alreadyUndone: false, notice: null });
    },
  } as unknown as Source;
}

let undone: number[] = [];
let host: HTMLElement | null = null;
let unmount: (() => void) | null = null;

function setUp(cli: CliInfo) {
  undone = [];
  const personal = notebook(
    A,
    'Personal',
    'synced',
    [entry(1, 1_000, 'Claude Code', 'Made the folder “Garden”')],
    undone,
  );
  const docs = notebook(
    B,
    'Penmoss Docs',
    'stopped',
    [entry(1, 2_000, 'Codex', 'Renamed the tag #ideas')],
    undone,
  );
  const state = {
    all: [personal, docs],
    journal: personal,
    journalPicked: true,
    loaded: true,
  } as unknown as SourcesState;
  const sources = { subscribe: () => () => undefined, getState: () => state } as unknown as Sources;
  const git = {
    agents: (localId: string) =>
      Promise.resolve({
        ok: true,
        value: localId === `local-${A}` ? [agent('Claude Code', 'personal-claude-code')] : [],
      }),
    cli: () => Promise.resolve(cli),
  } as unknown as DesktopGit;
  (window as unknown as { penmossDesktop: unknown }).penmossDesktop = { git };
  return sources;
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
async function mount(sources: Sources, element: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(<SourcesContext.Provider value={sources}>{element}</SourcesContext.Provider>),
  );
  unmount = () => root.unmount();
  await settle();
  await settle();
  return host;
}

const all = (root: HTMLElement, id: string) => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
];
const find = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error('not found');
  act(() => element.click());
  await settle();
};

const healthy: CliInfo = {
  path: '/Users/me/.local/bin/penmoss',
  state: 'installed',
  onPath: true,
  pathLine: 'export PATH="$HOME/.local/bin:$PATH"',
  profile: '~/.zshrc',
  direct: '/Applications/Penmoss.app/Contents/MacOS/Penmoss --penmoss-cli',
  server: {
    server: 'penmoss',
    claude:
      'claude mcp add penmoss -- /Applications/Penmoss.app/Contents/MacOS/Penmoss --penmoss-cli mcp',
    claudeChannel:
      'claude mcp add penmoss -- /Applications/Penmoss.app/Contents/MacOS/Penmoss --penmoss-cli mcp --channel',
    claudeLaunch: 'claude --dangerously-load-development-channels server:penmoss',
    codex: '[mcp_servers."penmoss"]',
  },
};

beforeEach(() => {
  history.replaceState(null, '', '/settings/agents');
});

afterEach(() => {
  if (unmount) act(unmount);
  unmount = null;
  host?.remove();
  host = null;
  delete (window as unknown as { penmossDesktop?: unknown }).penmossDesktop;
});

describe('Settings → Agents, one page, folded (PEN-146)', () => {
  it('opens with the notebook its address names unfolded, the others folded', async () => {
    const root = await mount(setUp(healthy), <AgentsSettings item={A} />);
    const rows = all(root, 'agents-notebook-row');
    expect(rows.map((row) => row.dataset['open'])).toEqual(['true', undefined]);
    expect(all(root, 'notebook-agents')).toHaveLength(1);
    expect(find(rows[0]!, 'git-local-agent')?.textContent).toContain('Claude Code');
    expect(find(rows[0]!, 'agents-notebook-count')?.textContent).toBe('Claude Code');
    expect(find(rows[1]!, 'agents-notebook-count')?.textContent).toBe('No Agent Copies');
    expect(rows[1]!.dataset['path']).toBe(`/settings/agents/${B}`);
    // A fold folds and unfolds in place.
    await click(find(rows[0]!, 'agents-notebook-fold'));
    expect(all(root, 'notebook-agents')).toHaveLength(0);
    expect(find(rows[0]!, 'agents-notebook-fold')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('offers the one MCP server for every notebook, and nothing asks for an agent’s name (PEN-155)', async () => {
    const root = await mount(setUp(healthy), <AgentsSettings />);
    expect(find(root, 'agents-server-claude')?.textContent).toContain(
      'claude mcp add penmoss -- /Applications/Penmoss.app/Contents/MacOS/Penmoss --penmoss-cli mcp',
    );
    expect(find(root, 'agents-connect-open')).toBeNull();
    await click(find(all(root, 'agents-notebook-row')[1]!, 'agents-notebook-fold'));
    expect(find(root, 'git-local-agent-label')).toBeNull();
  });

  it('shows the penmoss command on one line when it works, and the card behind Manage…', async () => {
    const root = await mount(setUp(healthy), <AgentsSettings />);
    const line = find(root, 'git-cli')!;
    expect(line.dataset['compact']).toBe('true');
    expect(line.textContent).toContain('penmoss Command Installed');
    expect(line.textContent).toContain('/Users/me/.local/bin/penmoss');
    expect(find(root, 'git-cli-install')).toBeNull();
    await click(find(root, 'git-cli-manage'));
    expect(find(root, 'git-cli')?.dataset['compact']).toBeUndefined();
    expect(find(root, 'git-cli-install')?.textContent).toBe('Reinstall');
    expect(find(root, 'agents-activity-link')?.getAttribute('href')).toBe(
      '/settings/agent-activity',
    );
  });

  it('shows the full card when the command is not installed', async () => {
    const root = await mount(
      setUp({ ...healthy, state: 'missing', onPath: null }),
      <AgentsSettings />,
    );
    expect(find(root, 'git-cli')?.dataset['compact']).toBeUndefined();
    expect(find(root, 'git-cli-install')?.textContent).toBe('Install Command');
  });
});

describe('Settings → Agent Activity (PEN-146)', () => {
  it('lists every notebook’s agent changes, newest first, filters them, and undoes one', async () => {
    const root = await mount(setUp(healthy), <AgentActivitySettings />);
    const list = () => [...root.querySelectorAll('[data-testid="agent-activity-list"] li')];
    expect(list().map((item) => item.textContent)).toEqual([
      expect.stringContaining('Renamed the tag #ideas✦ Codex · Penmoss Docs'),
      expect.stringContaining('Made the folder “Garden”✦ Claude Code · Personal'),
    ]);
    const notebookFilter = find(root, 'agent-activity-notebook') as HTMLSelectElement;
    act(() => {
      notebookFilter.value = A;
      notebookFilter.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(list()).toHaveLength(1);
    await click(list()[0]!.querySelector('button'));
    expect(undone).toEqual([1]);
    expect(find(root, 'agent-activity-status')?.textContent).toBe(
      'Undone: Made the folder “Garden”.',
    );
  });
});

describe('Each notebook in Settings’ nav (PEN-146)', () => {
  it('links each notebook with its sync dot, the open one current', async () => {
    const root = await mount(setUp(healthy), <NotebookNavEntries current={B} />);
    const entries = all(root, 'settings-notebook-entry');
    expect(entries.map((each) => each.getAttribute('href'))).toEqual([
      `/settings/git-notebooks/${A}`,
      `/settings/git-notebooks/${B}`,
    ]);
    expect(entries.map((each) => each.dataset['state'])).toEqual(['ok', 'error']);
    expect(entries.map((each) => each.getAttribute('aria-current'))).toEqual([null, 'page']);
    // Its name is the notebook's alone (Title Case, PEN-182); its sync line is its description.
    expect(entries[1]!.textContent).toBe('Penmoss Docs');
    const described = entries[1]!.getAttribute('aria-describedby');
    expect(root.querySelector(`#${described}`)?.textContent).toBe('Sync Stopped');
    // Each starts with its notebook's badge (PEN-140), its default letter, beside the dot.
    expect(
      entries.map((each) =>
        each.querySelector('[data-testid="notebook-badge"]')?.getAttribute('data-glyph'),
      ),
    ).toEqual(['letter:P', 'letter:P']);
  });
});
