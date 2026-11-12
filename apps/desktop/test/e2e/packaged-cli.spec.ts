/**
 * PEN-121: an agent's MCP server never stands in for the Penmoss app. The bug is in a packaged
 * bundle only, so this spec packs one (arm64, ad hoc, `--dir`; once per run, reused while it is
 * newer than the build) and opens it the way a person does, with `open -g`, in the test VM.
 *
 * The packaged app has Electron's inspect fuse off (A224), so Playwright's `_electron.launch`
 * can't drive it: each launch is `open -g … --args --remote-debugging-port=<port>`, and Playwright
 * connects over Chromium's DevTools protocol. LaunchServices is read with `lsappinfo list`, and a
 * window on screen with CoreGraphics (a small Swift script), which needs no permission.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { checkoutPortBase } from '../../../../packages/core/test/support/checkout-ports';
import { parseBlock } from '../../../../scripts/ports.mjs';
import { inVirtualMachine, refuseOnMacHost } from './host-guard';
import { bareRepository, dataDir, DESKTOP, go, removeDataDirs } from './support';

refuseOnMacHost('The packaged app’s spec');
test.skip(process.platform !== 'darwin', 'Needs a packaged Mac app and LaunchServices');

const APP = join(DESKTOP, 'release', 'mac-arm64', 'Penmoss.app');
const MAIN_EXE = join(APP, 'Contents', 'MacOS', 'Penmoss');
const CLI_EXE = join(APP, 'Contents', 'Helpers', 'Penmoss CLI.app', 'Contents', 'MacOS', 'Penmoss');
const APP_ID = 'app.penmoss.mac';
const CLI_ID = 'app.penmoss.mac.cli';

/** Ports for the DevTools protocol, one per launch: this run's port block, or this checkout's. */
const block = parseBlock(process.env['PENMOSS_PORT_BLOCK']);
const PORT_BASE = block > 0 ? 20000 + 100 * block + 60 : checkoutPortBase() + 6;
let nextPort = 0;
const port = () => PORT_BASE + (nextPort++ % 4);

const children: ChildProcess[] = [];

// --- packing ---

test.beforeAll(() => {
  test.setTimeout(900_000);
  const asar = join(APP, 'Contents', 'Resources', 'app.asar');
  const built = statSync(join(DESKTOP, 'dist', 'boot.cjs')).mtimeMs;
  if (existsSync(CLI_EXE) && existsSync(asar) && statSync(asar).mtimeMs >= built) return;
  const env: NodeJS.ProcessEnv = { ...process.env, PENMOSS_MAC_ARCH: 'arm64' };
  // Ad hoc, whatever this machine has: no certificate, no notarisation.
  for (const name of ['CSC_LINK', 'CSC_NAME', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_ID'])
    delete env[name];
  const packed = spawnSync(
    join(DESKTOP, 'node_modules', '.bin', 'electron-builder'),
    ['--config', 'electron-builder.config.cjs', '--publish', 'never', '--dir', '--mac'],
    { cwd: DESKTOP, env, encoding: 'utf8', timeout: 840_000 },
  );
  if (packed.status !== 0) {
    throw new Error(`Packing failed (${packed.status}):\n${packed.stdout}\n${packed.stderr}`);
  }
});

test.beforeEach(() => {
  // The VM is the test machine, and this is the packaged app's own data: it starts fresh.
  if (!inVirtualMachine()) throw new Error('Only in the test VM');
  quitAll();
  rmSync(join(homedir(), 'Library', 'Application Support', 'Penmoss'), {
    recursive: true,
    force: true,
  });
});

test.afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  quitAll();
});
test.afterAll(() => removeDataDirs());

// --- LaunchServices ---

interface Registered {
  readonly pid: number;
  readonly bundleId: string | null;
  readonly type: string | null;
  readonly executable: string | null;
  readonly text: string;
}

/** Every process LaunchServices knows, as `lsappinfo list` says. */
function registered(): Registered[] {
  const out = execFileSync('/usr/bin/lsappinfo', ['list'], { encoding: 'utf8' });
  return out
    .split(/^\s*\d+\) /m)
    .slice(1)
    .map((text) => ({
      pid: Number(/\bpid = (\d+)/.exec(text)?.[1] ?? 0),
      bundleId: /bundleID="([^"]*)"/.exec(text)?.[1] ?? null,
      type: /\btype="([^"]*)"/.exec(text)?.[1] ?? null,
      executable: /executable path="([^"]*)"/.exec(text)?.[1] ?? null,
      text: text.trim(),
    }));
}

const penmossApps = () => registered().filter((each) => each.bundleId === APP_ID);
const registeredAs = (pid: number) => registered().find((each) => each.pid === pid) ?? null;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Quits every Penmoss of this bundle (the app, and old-path CLIs a test left). */
function quitAll(): void {
  spawnSync('/usr/bin/pkill', ['-TERM', '-f', APP]);
  const until = Date.now() + 15_000;
  while (Date.now() < until && spawnSync('/usr/bin/pgrep', ['-f', APP]).status === 0) {
    spawnSync('/bin/sleep', ['0.5']);
  }
  spawnSync('/usr/bin/pkill', ['-KILL', '-f', APP]);
}

/** Quits the app as Penmoss → Quit Penmoss does (it handles SIGTERM the same way), and waits. */
async function quitApp(pid: number): Promise<void> {
  process.kill(pid, 'SIGTERM');
  await expect.poll(() => alive(pid), { timeout: 20_000 }).toBe(false);
}

const SWIFT_WINDOWS = `import CoreGraphics
let pid = Int32(CommandLine.arguments[1])!
let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
print(all.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }.count)
`;
let swiftFile: string | null = null;
/** The windows `pid` has on screen (normal windows only), from CoreGraphics. */
function windowsOnScreen(pid: number): number {
  if (!swiftFile) {
    swiftFile = join(dataDir(), 'windows.swift');
    writeFileSync(swiftFile, SWIFT_WINDOWS);
  }
  const out = spawnSync('/usr/bin/swift', [swiftFile, String(pid)], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return Number(out.stdout.trim()) || 0;
}

/** Opens Penmoss as the Dock and the Finder do: LaunchServices starts it or reopens it. */
function open(env: Readonly<Record<string, string>>, debugPort: number): void {
  const opened = spawnSync(
    '/usr/bin/open',
    [
      '-g',
      ...Object.entries(env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
      APP,
      '--args',
      `--remote-debugging-port=${debugPort}`,
    ],
    { encoding: 'utf8' },
  );
  expect(opened.status, opened.stderr).toBe(0);
}

/** The app's main window, over the DevTools protocol. */
async function connect(debugPort: number): Promise<{ browser: Browser; page: Page }> {
  await expect
    .poll(
      () =>
        fetch(`http://127.0.0.1:${debugPort}/json/version`).then(
          (response) => response.ok,
          () => false,
        ),
      { timeout: 45_000 },
    )
    .toBe(true);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const find = () =>
    browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url().startsWith('app://penmoss/') && !page.url().endsWith('/capture'));
  await expect.poll(() => find() !== undefined, { timeout: 30_000 }).toBe(true);
  return { browser, page: find()! };
}

// --- recording (proof mode, the software factory's F7) ---

const proof = process.env['PENMOSS_PROOF'] === '1';

/** Frames of every window this test connects to, as support.ts's recordWindow attaches them. */
function recorder() {
  const info = test.info();
  const dir = info.outputPath(`frames-${Date.now().toString(36)}`);
  const frames: { file: string; at: number }[] = [];
  let last: Page | null = null;
  return {
    async record(page: Page) {
      last = page;
      if (!proof) return;
      mkdirSync(dir, { recursive: true });
      const cdp = await page.context().newCDPSession(page);
      cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
        const file = `${String(frames.length).padStart(5, '0')}.jpg`;
        writeFileSync(join(dir, file), Buffer.from(data, 'base64'));
        frames.push({ file, at: metadata.timestamp ?? Date.now() / 1000 });
        void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80 });
    },
    async finish() {
      if (last && !last.isClosed()) {
        const shot = info.outputPath('screenshot.png');
        await last.screenshot({ path: shot }).catch(() => undefined);
        await info
          .attach('screenshot', { path: shot, contentType: 'image/png' })
          .catch(() => undefined);
      }
      if (proof && frames.length > 0) {
        await info.attach('video-frames', {
          body: JSON.stringify({ dir, frames }),
          contentType: 'application/json',
        });
      }
    },
  };
}

// --- the CLI and its MCP server ---

/** A home for the CLI's notebooks and git's identity, shared by the app and the CLI. */
function world() {
  const root = dataDir();
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(
    gitconfig,
    '[user]\n  name = Ryan on the Mac\n  email = ryan@example.invalid\n[commit]\n  gpgSign = false\n',
  );
  const app = { PENMOSS_HOME: join(root, 'penmoss'), GIT_CONFIG_GLOBAL: gitconfig };
  const env = { ...process.env, ...app, GIT_CONFIG_NOSYSTEM: '1' };
  const cli = (exe: string, args: readonly string[]) =>
    spawnSync(exe, ['--penmoss-cli', ...args], { env, encoding: 'utf8', timeout: 90_000 });
  return { app, env, cli };
}

/** Words of a shell command line as shellWord (local-agents.ts) writes them. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  for (const match of line.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)) {
    words.push(match[1] !== undefined ? match[1].replaceAll(`'\\''`, `'`) : match[2]!);
  }
  return words;
}

/** An MCP server an agent started: JSON-RPC over its stdin and stdout, kept running. */
function mcpServer(words: readonly string[], env: NodeJS.ProcessEnv) {
  const child = spawn(words[0]!, words.slice(1), { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  type Reply = { id?: number; result?: { tools?: unknown[] }; error?: unknown };
  const replies = new Map<number, Reply>();
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
    let at;
    while ((at = out.indexOf('\n')) !== -1) {
      const line = out.slice(0, at).trim();
      out = out.slice(at + 1);
      if (!line) continue;
      try {
        const reply = JSON.parse(line) as Reply;
        if (typeof reply.id === 'number') replies.set(reply.id, reply);
      } catch {
        // Not a reply.
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  let id = 0;
  const ask = async (method: string, params: unknown) => {
    id += 1;
    const asked = id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: asked, method, params })}\n`);
    await expect
      .poll(() => replies.has(asked) || child.exitCode !== null, { timeout: 60_000 })
      .toBe(true);
    const reply = replies.get(asked);
    if (!reply) throw new Error(`The MCP server ended (${child.exitCode}): ${err}`);
    return reply;
  };
  return {
    child,
    stderr: () => err,
    async start() {
      const init = await ask('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'packaged-cli.spec', version: '1' },
      });
      expect(init.error).toBeUndefined();
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
    },
    async tools(): Promise<number> {
      const listed = await ask('tools/list', {});
      return listed.result?.tools?.length ?? 0;
    },
  };
}

/** Makes a git notebook in the app on a new bare repository, from its first-run screen. */
async function addNotebook(page: Page, name: string): Promise<void> {
  const remote = bareRepository();
  await expect(page.getByTestId('first-run')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('first-run-new').click();
  const form = page.getByTestId('git-add');
  await form.getByTestId('git-add-remote').fill(`file://${remote}`);
  await form.getByTestId('git-add-name').fill(name);
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#app-sidebar').getByText(name, { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
}

const attachText = (name: string, body: string) =>
  test.info().attach(name, { body, contentType: 'text/plain' });

// --- the tests ---

test('an MCP server added before this build still lets Penmoss open, and keeps serving', async () => {
  test.setTimeout(300_000);
  const w = world();
  // An agent's clone, made by the CLI from the app's own binary, the old path.
  const remote = bareRepository();
  const added = w.cli(MAIN_EXE, [
    'notebook',
    'add',
    `file://${remote}`,
    '--name',
    'old-agent',
    '--agent',
    'Old agent',
  ]);
  expect(added.status, added.stderr).toBe(0);
  const server = mcpServer([MAIN_EXE, '--penmoss-cli', 'mcp', '--notebook', 'old-agent'], w.env);
  await server.start();
  expect(await server.tools()).toBeGreaterThan(20);
  const cliPid = server.child.pid!;
  await attachText(
    'lsappinfo: the old-path MCP server',
    registeredAs(cliPid)?.text ?? 'not registered',
  );

  // Penmoss → Quit Penmoss already happened: no app runs, only the server. Opening Penmoss
  // starts the app, either at once or through the server's safety net (open -n).
  expect(penmossApps().filter((each) => each.pid !== cliPid)).toEqual([]);
  open(w.app, port());
  let appPid = 0;
  await expect
    .poll(
      () => {
        appPid = penmossApps().find((each) => each.pid !== cliPid && alive(each.pid))?.pid ?? 0;
        return appPid;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await expect.poll(() => windowsOnScreen(appPid), { timeout: 60_000 }).toBeGreaterThan(0);
  await attachText(
    'lsappinfo: after open -g',
    registered()
      .filter((each) => each.bundleId === APP_ID || each.bundleId === CLI_ID)
      .map((each) => each.text)
      .join('\n\n'),
  );

  // The server went on serving its agent throughout.
  expect(server.child.exitCode).toBe(null);
  expect(await server.tools()).toBeGreaterThan(20);
});

test('agents run the CLI bundle; Penmoss opens from the Dock and Finder while one runs', async () => {
  test.setTimeout(420_000);
  const w = world();
  const shots = recorder();

  // AC8: the CLI bundle is signed with the app.
  const verified = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', APP], {
    encoding: 'utf8',
  });
  expect(verified.status, verified.stderr).toBe(0);

  // The CLI from its bundle: its version, its exit codes.
  const version = w.cli(CLI_EXE, ['--version']);
  expect(version.status, version.stderr).toBe(0);
  expect(version.stdout).toMatch(/^penmoss \d+\.\d+\.\d+/);
  expect(w.cli(CLI_EXE, ['notebook', 'status', 'nope']).status).toBe(4);

  // Penmoss, opened as the Finder opens it, with a notebook.
  const first = port();
  open(w.app, first);
  let { browser, page } = await connect(first);
  await shots.record(page);
  await addNotebook(page, 'Notes');

  // Settings → Agents: the notebook's automatic agent, and the command, name the CLI bundle.
  await go(page, '/settings/agents');
  const row = page.getByTestId('agents-notebook-row').filter({ hasText: 'Notes' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  const href = (await row.getAttribute('href'))!;
  const automatic = page.locator('[data-testid="git-local-agent"][data-name="notes-agent"]');
  await expect(async () => {
    // The list is read when the page opens: open it again until the app has made the copy.
    await go(page, '/settings/git-notebooks');
    await go(page, href);
    await expect(automatic).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  const claude = automatic.getByTestId('git-local-agent-claude').locator('code');
  await claude.scrollIntoViewIfNeeded();
  const command = (await claude.textContent())!;
  expect(command).toContain(`'${CLI_EXE}' --penmoss-cli mcp --notebook notes-agent`);
  await expect(automatic.getByTestId('git-local-agent-codex')).toContainText(
    `command = "${CLI_EXE}"`,
  );
  await page.waitForTimeout(2_000);

  // The agent runs the command it was given: the MCP server answers, and LaunchServices knows it
  // only as the CLI, never as Penmoss.
  const server = mcpServer(shellWords(command.split(' -- ')[1]!), w.env);
  await server.start();
  expect(await server.tools()).toBeGreaterThan(20);
  const cliPid = server.child.pid!;
  await page.waitForTimeout(2_000);
  const asCli = registeredAs(cliPid);
  await attachText('lsappinfo: the MCP server', asCli?.text ?? 'not registered');
  expect(asCli?.bundleId ?? CLI_ID).toBe(CLI_ID);
  const apps = penmossApps();
  expect(apps.map((each) => each.pid)).not.toContain(cliPid);
  expect(apps).toHaveLength(1);
  const firstPid = apps[0]!.pid;

  // Quit Penmoss; the server keeps running. Opening it again starts the app, to its window.
  await browser.close().catch(() => undefined);
  await quitApp(firstPid);
  expect(server.child.exitCode).toBe(null);
  const again = port();
  open(w.app, again);
  ({ browser, page } = await connect(again));
  await shots.record(page);
  const reopened = penmossApps();
  expect(reopened).toHaveLength(1);
  const appPid = reopened[0]!.pid;
  expect(appPid).not.toBe(firstPid);
  await expect.poll(() => windowsOnScreen(appPid), { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(
    page.locator('#app-sidebar').getByText('Notes', { exact: true }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });

  // Opening it while it runs brings its window forward, and starts no second app.
  open(w.app, port());
  await page.waitForTimeout(3_000);
  expect(penmossApps().map((each) => each.pid)).toEqual([appPid]);
  expect(windowsOnScreen(appPid)).toBeGreaterThan(0);
  await attachText(
    'lsappinfo: at the end',
    registered()
      .filter((each) => each.bundleId === APP_ID || each.bundleId === CLI_ID)
      .map((each) => each.text)
      .join('\n\n'),
  );

  // The server still answers its agent.
  expect(await server.tools()).toBeGreaterThan(20);

  // The command, on screen at the end.
  await go(page, href);
  await expect(automatic).toBeVisible({ timeout: 30_000 });
  await automatic.getByTestId('git-local-agent-claude').scrollIntoViewIfNeeded();
  await expect(automatic.getByTestId('git-local-agent-claude')).toContainText('Penmoss CLI.app');
  await page.waitForTimeout(2_000);
  await shots.finish();
  await browser.close().catch(() => undefined);
});
