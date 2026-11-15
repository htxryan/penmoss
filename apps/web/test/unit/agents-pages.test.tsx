// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../../src/agents/activity';
import type { CliInfo, DesktopGit, LocalAgentInfo } from '../../src/desktop/bridge';
import { AgentActivitySettings } from '../../src/sources/AgentActivitySettings';
import { AgentsSettings } from '../../src/sources/AgentsSettings';
import { lastUsed, statusWords } from '../../src/sources/agent-words';
import { NotebookNavEntries } from '../../src/sources/NotebookNavEntries';
import { SourcesContext } from '../../src/sources/hooks';
import type { Source, Sources, SourcesState } from '../../src/sources/registry';

// PEN-146: Settings → Agents is one page (a table and a drawer since A1578); Agent Activity
// lists every notebook's agent changes together; each notebook has its own entry in the nav.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = '01JB00000000000000000000AA';
const B = '01JB00000000000000000000BB';

const agent = (label: string, name: string, automatic = false): LocalAgentInfo => ({
  name,
  label,
  server: `penmoss-${name}`,
  claude: `claude mcp add penmoss-${name}`,
  claudeChannel: `claude mcp add penmoss-${name} --channel`,
  claudeLaunch: `claude server:penmoss-${name}`,
  codex: `[mcp_servers."penmoss-${name}"]`,
  mcp: `penmoss mcp --notebook ${name}`,
  automatic,
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
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const today = noon.getTime();
  const personal = notebook(
    A,
    'Personal',
    'synced',
    [entry(1, today, 'Claude Code', 'Made the folder “Garden”')],
    undone,
  );
  const docs = notebook(
    B,
    'Penmoss Docs',
    'stopped',
    [entry(1, today + 1_000, 'Codex', 'Renamed the tag #ideas')],
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
        value:
          localId === `local-${A}`
            ? [agent('Agent', 'personal-agent', true), agent('Claude Code', 'personal-claude-code')]
            : [agent('Agent', 'penmoss-docs-agent', true)],
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

describe('Settings → Agents, a table and a drawer (A1578)', () => {
  it('lists a row per agent per notebook, each notebook’s Any Agent shared', async () => {
    const root = await mount(setUp(healthy), <AgentsSettings />);
    const rows = all(root, 'agents-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Claude CodePersonalUsed today',
      'Any AgentSharedPersonalReady',
      'Any AgentSharedPenmoss DocsReady',
    ]);
    expect(rows.map((row) => row.dataset['path'])).toEqual([
      `/settings/agents/${A}`,
      `/settings/agents/${A}`,
      `/settings/agents/${B}`,
    ]);
    // Each row is a button with its notebook's badge, and none is open yet.
    expect(rows.every((row) => row.tagName === 'BUTTON')).toBe(true);
    expect(rows.map((row) => row.querySelector('[data-testid="notebook-badge"]'))).not.toContain(
      null,
    );
    expect(rows.map((row) => row.getAttribute('aria-expanded'))).toEqual([
      'false',
      'false',
      'false',
    ]);
    expect(find(root, 'agents-drawer')).toBeNull();
  });

  it('a row opens its drawer, focus in it; Esc closes it and gives the row the focus', async () => {
    const root = await mount(setUp(healthy), <AgentsSettings />);
    const row = all(root, 'agents-row')[0]!;
    row.focus();
    await click(row);
    const drawer = find(root, 'agents-drawer')!;
    expect(drawer.tagName).toBe('ASIDE');
    expect(drawer.getAttribute('aria-label')).toBe('Claude Code on Personal');
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(row.dataset['selected']).toBe('true');
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(find(drawer, 'agents-drawer-sub')?.textContent).toBe(
      'Personal · its own copy · named “Claude Code” in History',
    );
    expect(find(drawer, 'git-local-agent-claude')?.textContent).toContain(
      'claude mcp add penmoss-personal-claude-code',
    );
    expect(find(drawer, 'git-local-agent-server')?.textContent).toBe(
      'penmoss-personal-claude-code',
    );
    expect(find(drawer, 'git-local-agent-disconnect')?.textContent).toBe('Disconnect…');
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(find(root, 'agents-drawer')).toBeNull();
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });

  it('Any Agent’s drawer has no Disconnect, and names the notebook agents reach it by', async () => {
    const root = await mount(setUp(healthy), <AgentsSettings />);
    await click(all(root, 'agents-row')[2]);
    const drawer = find(root, 'agents-drawer')!;
    expect(drawer.getAttribute('aria-label')).toBe('Any Agent on Penmoss Docs');
    expect(find(drawer, 'git-local-agent-disconnect')).toBeNull();
    expect(find(drawer, 'git-local-agent-automatic')).not.toBeNull();
    expect(find(drawer, 'git-local-agent-notebook-name')?.textContent).toContain(
      'penmoss mcp --notebook "Penmoss Docs"',
    );
    // × closes it too.
    await click(find(drawer, 'agents-drawer-close'));
    expect(find(root, 'agents-drawer')).toBeNull();
  });

  it('opens with the notebook its address names in the drawer', async () => {
    const root = await mount(setUp(healthy), <AgentsSettings item={B} />);
    expect(find(root, 'agents-drawer')?.getAttribute('aria-label')).toBe(
      'Any Agent on Penmoss Docs',
    );
    expect(find(root, 'agents-notebook-missing')).toBeNull();
  });

  it('Connect an Agent… opens the drawer on the form, the cursor in the agent’s name', async () => {
    const root = await mount(setUp(healthy), <AgentsSettings />);
    await click(find(root, 'agents-connect-open'));
    const drawer = find(root, 'agents-drawer')!;
    expect(drawer.getAttribute('aria-label')).toBe('Connect an Agent');
    expect(document.activeElement).toBe(find(drawer, 'git-local-agent-label'));
    expect((find(drawer, 'agents-connect-notebook') as HTMLSelectElement).value).toBe(A);
  });

  it('shows the penmoss command on one line when it works, and the card behind Manage…', async () => {
    const root = await mount(setUp(healthy), <AgentsSettings />);
    const line = find(root, 'git-cli')!;
    expect(line.dataset['compact']).toBe('true');
    expect(line.textContent).toContain('penmoss command installed');
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

describe('An agent’s status in the table', () => {
  const at = (text: string) => new Date(text).getTime();
  const now = at('2026-11-15T15:00:00');
  it('says when its Agent Activity last named it, or Ready', () => {
    const entries = [
      entry(1, at('2026-11-15T09:00:00'), 'Codex', 'x'),
      entry(2, at('2026-11-14T22:00:00'), 'Claude Code', 'x'),
      entry(3, at('2026-11-01T09:00:00'), 'Claude Code', 'x'),
    ];
    expect(lastUsed(entries, 'Claude Code')).toBe(at('2026-11-14T22:00:00'));
    expect(lastUsed(entries, 'Agent')).toBeNull();
    expect(statusWords(lastUsed(entries, 'Codex'), now)).toBe('Used today');
    expect(statusWords(lastUsed(entries, 'Claude Code'), now)).toBe('Used yesterday');
    expect(statusWords(at('2026-11-01T09:00:00'), now)).toMatch(/^Used .*1/);
    expect(statusWords(null, now)).toBe('Ready');
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
    expect(entries[1]!.textContent).toContain('Penmoss Docs, Sync Stopped');
    // Each starts with its notebook's badge (PEN-140), its default letter, beside the dot.
    expect(
      entries.map((each) =>
        each.querySelector('[data-testid="notebook-badge"]')?.getAttribute('data-glyph'),
      ),
    ).toEqual(['letter:P', 'letter:P']);
  });
});
