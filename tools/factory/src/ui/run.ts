/** `factory ui`: serves the Factory UI on 127.0.0.1 (F20, #276). */
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Board } from '../board.ts';
import { expandHome, type FactoryConfig } from '../config.ts';
import { nodeExec } from '../exec.ts';
import { createGh } from '../github.ts';
import { planFiles, readMeta, readState, sessionIssue } from '../planning-host.ts';
import { openFactory } from '../start.ts';
import { createWriter, type Writer } from './actions.ts';
import { githubOwner, linearOwner, ownerKey } from './owner.ts';
import { createLinearClient } from '../tracker/linear-client.ts';
import { codeDir } from '../code.ts';
import { readStatus } from '../status.ts';
import { readDoctorSummaries } from '../doctor-summary.ts';
import { buildView, type FactoryView, type PlanInfo } from './model.ts';
import { uiLinkPath, uiToken } from './link.ts';
import { tailnetHosts, tailnetLink } from './tailnet.ts';
import { pageHtml } from './page.ts';
import { createUiServer, listen } from './server.ts';

function readPlans(config: FactoryConfig): Record<number, PlanInfo> {
  const dir = join(expandHome(config.stateDir), 'plans');
  const plans: Record<number, PlanInfo> = {};
  if (!existsSync(dir)) return plans;
  for (const name of readdirSync(dir)) {
    const n = Number(name);
    if (!Number.isInteger(n)) continue;
    const files = planFiles(config, n);
    plans[n] = { meta: readMeta(files), state: readState(files)?.state ?? null };
  }
  return plans;
}

async function busySessions(config: FactoryConfig): Promise<Set<number>> {
  const r = await nodeExec(config.agents.claude.bin, ['agents', '--json'], {
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '' },
  });
  const busy = new Set<number>();
  if (r.code !== 0) return busy;
  try {
    for (const s of JSON.parse(r.stdout || '[]') as { name?: string; status?: string }[]) {
      const n = sessionIssue(config, s.name);
      if (n !== undefined && s.status === 'busy') busy.add(n);
    }
  } catch {
    // An older CLI without --json: no busy markers.
  }
  return busy;
}

/**
 * The UI's writer, acting as Ryan (F21): his own gh login, or his own Linear key. Never the bot's
 * or the factory app's. When the credential answers as anyone else, the UI is read-only, and the
 * page says why.
 */
async function ownWriter(
  config: FactoryConfig,
  log: (line: string) => void,
): Promise<{ readonly writer?: Writer; readonly readOnly: string | null }> {
  const readOnly = (why: string) => {
    log(`Read-only: ${why}.`);
    return { readOnly: why };
  };
  if (config.tracker === 'linear') {
    const key = await ownerKey(config);
    if (!key) return readOnly(`no Linear key in the keychain item ${config.linear.keychainItem}`);
    const client = createLinearClient({ token: () => Promise.resolve(key) });
    const me = await client
      .request<{ viewer: { id: string } }>('query { viewer { id } }')
      .then((r) => r.viewer.id)
      .catch(() => '');
    if (!config.linear.owner || me !== config.linear.owner)
      return readOnly(
        `the Linear key in ${config.linear.keychainItem} isn't Ryan's (config.linear.owner)`,
      );
    return { writer: createWriter(config, linearOwner(config, client)), readOnly: null };
  }
  // Ryan's writes go through his own gh login (F21), never the bot's.
  const own = createGh({
    exec: nodeExec,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '' },
  });
  const login = (await own.run(['api', 'user', '--jq', '.login']).catch(() => '')).trim();
  if (login === config.owner)
    return { writer: createWriter(config, githubOwner(config, own)), readOnly: null };
  return readOnly(`your gh is signed in as "${login || 'nobody'}", not ${config.owner}`);
}

/** Whether a process is alive: `status.json` alone can't say the daemon died. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, but someone else's.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The last lines of a run's agent log: read from its end, at most 64 KiB, colours stripped. */
export function tailFile(file: string, lines = 8): string[] {
  try {
    const size = statSync(file).size;
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return (
      buffer
        .toString('utf8')
        // eslint-disable-next-line no-control-regex
        .replaceAll(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.trim() !== '')
        .slice(-lines)
        .map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
    );
  } catch {
    return [];
  }
}

/** The view from the state folder: the ledger, status.json, plans, doctor results and run logs. */
export function viewFromState(
  config: FactoryConfig,
  board: Board,
  options: {
    readonly busy: ReadonlySet<number>;
    readonly alive: (pid: number) => boolean;
    readonly now: Date;
    readonly writable: boolean;
    readonly readOnly: string | null;
  },
): FactoryView {
  const state = expandHome(config.stateDir);
  const ledgerPath = join(state, 'runs.jsonl');
  const runFolder = (run: string) => join(state, 'runs', run);
  return buildView({
    config,
    board,
    ledger: existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '',
    plans: readPlans(config),
    busySessions: options.busy,
    status: readStatus(config) ?? null,
    alive: options.alive,
    now: options.now,
    codeDir: codeDir(config),
    doctor: readDoctorSummaries(config),
    logTail: (run) => tailFile(join(runFolder(run), 'agent.log')),
    runFolder,
    writable: options.writable,
    readOnly: options.readOnly,
  });
}

export async function runUi(config: FactoryConfig, log: (line: string) => void): Promise<number> {
  // The UI never touches the runs' clone: the daemon, restarted with it, prepares that.
  const opened = await openFactory(config, { clone: false });
  if (!opened.ok) {
    log(`Can't start the UI: ${opened.error}.`);
    return 2;
  }
  const { tracker } = opened.factory;
  const { writer, readOnly } = await ownWriter(config, log);
  let board: { at: number; value: Board } | undefined;
  const view = async (): Promise<FactoryView> => {
    // The board costs a GitHub query; once every 30 s is plenty.
    if (!board || Date.now() - board.at > 30_000)
      board = { at: Date.now(), value: await tracker.readBoard() };
    return viewFromState(config, board.value, {
      busy: await busySessions(config),
      alive: isAlive,
      now: new Date(),
      writable: !!writer,
      readOnly,
    });
  };
  const token = uiToken(expandHome(config.stateDir));
  // Ryan's other devices reach it through `tailscale serve`, if he set that up (A1246).
  const remote = await tailnetHosts(nodeExec, config.ui.port);
  const server = createUiServer({
    port: config.ui.port,
    token,
    page: pageHtml,
    view,
    remote,
    ...(writer ? { writer } : {}),
  });
  const port = await listen(server, config.ui.port);
  const link = `http://127.0.0.1:${port}/?token=${token}`;
  writeFileSync(uiLinkPath(config), `${link}\n`, { mode: 0o600 });
  log(`Factory UI: ${link}`);
  for (const host of remote) log(`Factory UI on the tailnet: ${tailnetLink(host, token)}`);
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  writeFileSync(uiLinkPath(config), '', { mode: 0o600 });
  return 0;
}
