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
  launch,
  mainBounds,
  removeDataDirs,
  type Launched,
} from './support';

// T54 (D47; A992–A994): everything on one Mac with no account. The app is the CLI
// (`--penmoss-cli`), writes the `penmoss` command, and connects an agent to a git notebook: the
// agent's own clone in `~/.penmoss`, made after Touch ID (the suite's stand-in owner check),
// served by the local MCP server the Settings page shows how to run.
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

test('no account: connect an agent on this Mac; its MCP server writes the notebook through git', async () => {
  test.setTimeout(240_000);
  const w = world();
  const launched = await launch({
    env: { ...w.app, PENMOSS_TEST_HOME: w.home, PENMOSS_TEST_GIT_CONFIG: w.config },
  });
  opened.push(launched);
  const { page } = launched;
  await mainBounds(launched.app, { x: 0, y: 0, width: 1200, height: 900 });

  // A git notebook made on the Mac: one on this machine syncs without a check (D51).
  // With none yet, the app opens on the first-run screen and its Add form (T59, A1030).
  answerChecks(launched, 'confirm');
  await expect(page.getByTestId('first-run')).toBeVisible({ timeout: 30_000 });
  // The welcome's "Open a notebook you already have" (T69, A1146).
  await page.getByTestId('first-run-existing').click();
  const form = page.getByTestId('git-add');
  await form.getByTestId('git-add-remote').fill(`file://${w.remote}`);
  await form.locator('button[type="submit"]').click();
  await expect(form.getByTestId('git-add-message')).toContainText('name the new one', {
    timeout: 30_000,
  });
  const name = `Notes ${RUN}`;
  await form.getByTestId('git-add-name').fill(name);
  await form.locator('button[type="submit"]').click();
  // Nobody was asked to confirm anything.
  expect(checksAsked(launched)).toEqual([]);
  await expect(page.locator('#app-sidebar').getByText(name, { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  // The notebook's own page, from Settings → Git Notebooks' list (A1098).
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
  // which no Disconnect removes, and `penmoss mcp --notebook <the notebook's name>` serves it.
  // The page lists the notebooks, each with a page of its own for its agents (A1125).
  await go(page, '/settings/agents');
  const row = page.getByTestId('agents-notebook-row').filter({ hasText: name });
  await expect(row).toHaveAttribute('href', `/settings/agents/${notebookId}`);
  await row.click();
  const agentsPage = page.getByTestId('agents-settings');
  const notebookAgents = agentsPage.getByTestId('notebook-agents').filter({ hasText: name });
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
  await expect(automatic.getByTestId('git-local-agent-disconnect')).toHaveCount(0);
  await expect(notebookAgents).toContainText(`penmoss mcp --notebook "${name}"`);

  // The penmoss command, on the list page: written under the suite's home, running this app.
  await page.getByTestId('agents-back').click();
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

  // Connect an Agent, on the notebook's page: Touch ID, then its own clone, and the commands to
  // give it the server.
  await row.click();
  await agents.getByTestId('git-local-agent-label').fill('Codex');
  await agents.getByTestId('git-local-agent-connect').click();
  await expect(agents.getByTestId('git-local-agent-message')).toContainText('Connected “Codex”');
  const clone = `notes-${RUN}-codex`;
  const codex = agents.locator(`[data-testid="git-local-agent"][data-name="${clone}"]`);
  const claude = await codex.getByTestId('git-local-agent-claude').locator('code').textContent();
  expect(claude).toBe(
    `claude mcp add penmoss-${clone} -- ${ELECTRON} ${DESKTOP.replace(/\/$/, '')} --penmoss-cli mcp --notebook ${clone}`,
  );
  await expect(codex.getByTestId('git-local-agent-codex')).toContainText(
    `[mcp_servers."penmoss-${clone}"]`,
  );
  // Receive comments sent to this agent (T60, A1073): the channel, and how to start Claude Code.
  await codex.getByTestId('git-local-agent-channel').check();
  await expect(codex.getByTestId('git-local-agent-claude').locator('code')).toHaveText(
    `${claude} --channel`,
  );
  await expect(codex.getByTestId('git-local-agent-launch').locator('code')).toHaveText(
    `claude --dangerously-load-development-channels server:penmoss-${clone}`,
  );
  await codex.getByTestId('git-local-agent-channel').uncheck();
  await expect(codex.getByTestId('git-local-agent-claude').locator('code')).toHaveText(claude!);
  const listed = spawnSync(script, ['notebook', 'ls'], { env: w.env, encoding: 'utf8' });
  expect(listed.status, listed.stderr).toBe(0);
  expect(listed.stdout).toContain(clone);

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
        clientInfo: { name: 'c', version: '1' },
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

  // Disconnect removes the agent's clone, and only that: the automatic copy stays.
  await codex.getByTestId('git-local-agent-disconnect').click();
  await expect(agents.getByTestId('git-local-agent-message')).toContainText('Disconnected “Codex”');
  await expect(codex).toHaveCount(0);
  await expect(automatic).toBeVisible();
  expect(existsSync(join(w.home, '.penmoss', 'git'))).toBe(true);
  const after = spawnSync(script, ['notebook', 'ls'], { env: w.env, encoding: 'utf8' });
  expect(after.stdout).not.toContain(clone);
});
