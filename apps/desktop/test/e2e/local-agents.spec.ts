import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  answerChecks,
  checksAsked,
  dataDir,
  DESKTOP,
  firstRunName,
  firstRunPasteUrl,
  launch,
  mainBounds,
  removeDataDirs,
  type Launched,
} from './support';

// T54 (D47; A992–A994; PEN-155): everything on one Mac with no account. The app is the CLI
// (`--penmoss-cli`), writes the `penmoss` command, and Settings → Agents gives every agent the
// one MCP server (`penmoss mcp`), which reaches each notebook through the agent copy the app made.
// An older copy connected by name is listed with Remove.
// Only git on PATH: no keychain tool, so the CLI keeps its secrets in `~/.penmoss` here.

/** The Electron binary the suite runs, as Playwright finds it. */
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;
const RUN = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

/** A bare repository, a git config naming the committer, a home and PATH with only git. */
function world() {
  const root = dataDir();
  const remote = join(root, 'notes.git');
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  const config = join(root, 'gitconfig');
  writeFileSync(
    config,
    [
      '[user]',
      '  name = Ryan on the Mac',
      '  email = ryan@example.invalid',
      '[commit]',
      '  gpgSign = false',
      '',
    ].join('\n'),
  );
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // The stand-in owner check reads its answer with cat.
  for (const tool of ['git', 'xcode-select', 'cat']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) symlinkSync(found, join(bin, tool));
  }
  const home = join(root, 'home');
  mkdirSync(home);
  /** The app's environment: the CLI's home, PATH with only those tools, a plain login shell. */
  const app = { PATH: bin, PENMOSS_HOME: join(home, '.penmoss'), SHELL: '/bin/sh' };
  /** The CLI's, as an agent or a terminal starts it. */
  const env = {
    ...process.env,
    ...app,
    HOME: home,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const files = () =>
    execFileSync('git', ['-C', remote, 'ls-tree', '-r', '--name-only', 'main'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  return { root, remote, config, home, app, env, files };
}

/** Goes to a path inside the app, as a link does (no reload). */
const go = (page: Page, path: string) =>
  page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);

test('the app is the CLI: --penmoss-cli runs penmoss, with no window and no Node', () => {
  const w = world();
  const cli = (args: readonly string[]) =>
    spawnSync(ELECTRON, [DESKTOP, '--penmoss-cli', ...args], {
      env: w.env,
      encoding: 'utf8',
      timeout: 60_000,
    });
  const version = cli(['--version']);
  expect(version.status, version.stderr).toBe(0);
  expect(version.stdout).toMatch(/^penmoss \d+\.\d+\.\d+/);
  const listed = cli(['notebook', 'ls']);
  expect(listed.status, listed.stderr).toBe(0);
  expect(listed.stdout).toContain('No git notebooks yet');
  const unknown = cli(['notebook', 'status', 'nope']);
  expect(unknown.status).toBe(4);
});

test('no account: the one MCP server Settings → Agents gives writes the notebook through git', async () => {
  test.setTimeout(240_000);
  const w = world();
  const launched = await launch({
    env: { ...w.app, PENMOSS_TEST_HOME: w.home, PENMOSS_TEST_GIT_CONFIG: w.config },
  });
  opened.push(launched);
  const { page } = launched;
  await mainBounds(launched.app, { x: 0, y: 0, width: 1200, height: 900 });

  // A git notebook made on the Mac: one on this machine syncs without a check (D51).
  // With none yet, the app opens on the first run (T59, A1030; First Run C): Paste a URL, and
  // the remote holds no notebook, so Name Your Notebook.
  answerChecks(launched, 'confirm');
  await firstRunPasteUrl(page, `file://${w.remote}`);
  const name = `Notes ${RUN}`;
  await firstRunName(page, name);
  // Nobody was asked to confirm anything.
  expect(checksAsked(launched)).toEqual([]);
  await expect(page.locator('#app-sidebar').getByText(name, { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  // The notebook's own page, from Settings → Notebooks' list (A1098).
  await go(page, '/settings/git-notebooks');
  const settings = page.getByTestId('git-notebooks-settings');
  await settings.getByTestId('git-notebook-row').filter({ hasText: name }).click();
  const card = settings.getByTestId('git-notebook').filter({ hasText: name });
  await card.getByTestId('git-sync-now').click();
  await expect(card.getByTestId('git-status')).toHaveAttribute('data-phase', 'synced', {
    timeout: 30_000,
  });
  const notebookId = (await card.getAttribute('data-notebook-id'))!;

  // Settings → Agents (A1098): every notebook has an agent copy the app made by itself (D52),
  // which no Remove removes, and the one server reaches the notebook through it.
  // The page lists the notebooks, each folding open in place to its agents (PEN-146), and
  // `/settings/agents/<id>` opens with that one unfolded.
  await go(page, '/settings/agents');
  const row = page.getByTestId('agents-notebook-row').filter({ hasText: name });
  await expect(row).toHaveAttribute('data-path', `/settings/agents/${notebookId}`);
  await row.getByTestId('agents-notebook-fold').click();
  const agentsPage = page.getByTestId('agents-settings');
  const notebookAgents = agentsPage.locator(
    `[data-testid="notebook-agents"][data-notebook-id="${notebookId}"]`,
  );
  const agents = notebookAgents.getByTestId('git-local-agents');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const automatic = agents.locator(`[data-testid="git-local-agent"][data-name="${slug}-agent"]`);
  await expect(async () => {
    // The list is read when the page opens: open it again until the copy is made.
    await go(page, '/settings/git-notebooks');
    await go(page, `/settings/agents/${notebookId}`);
    await expect(automatic).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(automatic.getByTestId('git-local-agent-automatic')).toBeVisible();
  await expect(automatic.getByTestId('git-local-agent-remove')).toHaveCount(0);

  // The penmoss command, on the same page: written under the suite's home, running this app.
  const command = agentsPage.getByTestId('git-cli');
  await expect(command).toHaveAttribute('data-state', 'missing');
  await command.getByTestId('git-cli-install').click();
  await expect(command).toHaveAttribute('data-state', 'installed');
  const script = join(w.home, '.local', 'bin', 'penmoss');
  expect(readFileSync(script, 'utf8')).toContain('--penmoss-cli "$@"');

  // The notebook's own name serves its automatic copy, as Copy Agent Reference says (D52).
  const byName = spawnSync(script, ['notebook', 'status', name, '--json'], {
    env: w.env,
    encoding: 'utf8',
  });
  expect(byName.status, byName.stderr).toBe(0);
  expect(JSON.parse(byName.stdout)).toMatchObject({ name: `${slug}-agent` });

  // The MCP Server (PEN-155): one command for every notebook, and nothing asks for a name.
  const server = agentsPage.getByTestId('agents-server');
  const claude = await server.getByTestId('agents-server-claude').locator('code').textContent();
  expect(claude).toBe(
    `claude mcp add penmoss -- ${ELECTRON} ${DESKTOP.replace(/\/$/, '')} --penmoss-cli mcp`,
  );
  await expect(server.getByTestId('agents-server-codex')).toContainText('[mcp_servers."penmoss"]');
  await expect(agentsPage.getByTestId('git-local-agent-label')).toHaveCount(0);
  await expect(agentsPage.getByTestId('agents-connect-open')).toHaveCount(0);
  // Receive Comments Sent to Claude Code Sessions (T60, A1073): the channel, and how to start it.
  await server.getByTestId('agents-server-channel').check();
  await expect(server.getByTestId('agents-server-claude').locator('code')).toHaveText(
    `${claude} --channel`,
  );
  await expect(server.getByTestId('agents-server-launch').locator('code')).toHaveText(
    'claude --dangerously-load-development-channels server:penmoss',
  );
  await server.getByTestId('agents-server-channel').uncheck();
  await expect(server.getByTestId('agents-server-claude').locator('code')).toHaveText(claude!);

  // The agent runs the command Settings gave it: the MCP server answers over stdio, writes the
  // note, and syncs it as the agent once its client is gone.
  const words = claude!.split(' -- ')[1]!.split(' ');
  const requests = [
    {
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'codex-mcp-client', title: 'Codex', version: '1' },
      },
    },
    { id: 2, method: 'tools/list', params: {} },
    {
      id: 3,
      method: 'tools/call',
      params: {
        name: 'create_note',
        arguments: { title: 'From Codex', markdown: 'Hello from the agent.' },
      },
    },
  ];
  const served = spawnSync(words[0]!, words.slice(1), {
    env: w.env,
    encoding: 'utf8',
    timeout: 60_000,
    input: requests.map((each) => `${JSON.stringify({ jsonrpc: '2.0', ...each })}\n`).join(''),
  });
  expect(served.status, served.stderr).toBe(0);
  const replies = served.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { id: number; result?: { tools?: unknown[] } });
  expect(replies.map((reply) => reply.id)).toEqual([1, 2, 3]);
  expect(replies[1]!.result?.tools?.length).toBeGreaterThan(20);
  await expect.poll(w.files, { timeout: 60_000 }).toContain('From Codex.md');

  // The app pulls it: the agent's note is in the notebook.
  await go(page, '/settings/git-notebooks');
  await settings.getByTestId('git-notebook-row').filter({ hasText: name }).click();
  await card.getByTestId('git-sync-now').click();
  await expect(card.getByTestId('git-status')).toHaveAttribute('data-phase', 'synced', {
    timeout: 30_000,
  });
  await go(page, '/');
  const section = page.getByTestId('source-section').filter({
    has: page.locator('.sb-section-name', { hasText: name }),
  });
  await expect(section).toBeVisible();
  await expect(section.getByText('From Codex')).toBeVisible({ timeout: 15_000 });
  await go(page, `/settings/agents/${notebookId}`);

  // An older copy connected by name (before PEN-155) is listed with Remove, and Remove removes
  // only it: the automatic copy stays.
  const clone = `notes-${RUN}-codex`;
  const added = spawnSync(
    script,
    ['notebook', 'add', `file://${w.remote}`, '--name', clone, '--agent', 'Codex'],
    { env: w.env, encoding: 'utf8', timeout: 60_000 },
  );
  expect(added.status, added.stderr).toBe(0);
  await go(page, '/settings/git-notebooks');
  await go(page, `/settings/agents/${notebookId}`);
  const older = agents.locator(`[data-testid="git-local-agent"][data-name="${clone}"]`);
  await expect(older.getByTestId('git-local-agent-older')).toBeVisible({ timeout: 15_000 });
  await older.getByTestId('git-local-agent-remove').click();
  await expect(agents.getByTestId('git-local-agent-message')).toContainText('Removed “Codex”');
  await expect(older).toHaveCount(0);
  await expect(automatic).toBeVisible();
  expect(existsSync(join(w.home, '.penmoss', 'git'))).toBe(true);
  const after = spawnSync(script, ['notebook', 'ls'], { env: w.env, encoding: 'utf8' });
  expect(after.stdout).not.toContain(clone);
});
