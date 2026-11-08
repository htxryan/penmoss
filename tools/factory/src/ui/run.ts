/** `factory ui`: serves the Factory UI on 127.0.0.1 (F20, #276). */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBoard, type Board } from '../board.ts';
import { expandHome, type FactoryConfig } from '../config.ts';
import { nodeExec } from '../exec.ts';
import { createGh } from '../github.ts';
import { planFiles, readMeta, readState, sessionName } from '../planning-host.ts';
import { openFactory } from '../start.ts';
import { createWriter } from './actions.ts';
import { buildView, type FactoryView, type PlanInfo } from './model.ts';
import { uiLinkPath } from './link.ts';
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
      const n = Number(/^Penmoss #(\d+) plan$/.exec(s.name ?? '')?.[1]);
      if (Number.isInteger(n) && s.name === sessionName(n) && s.status === 'busy') busy.add(n);
    }
  } catch {
    // An older CLI without --json: no busy markers.
  }
  return busy;
}

export async function runUi(config: FactoryConfig, log: (line: string) => void): Promise<number> {
  const opened = await openFactory(config);
  if (!opened.ok) {
    log(`Can't start the UI: ${opened.error}.`);
    return 2;
  }
  const { gh } = opened.factory;
  const state = expandHome(config.stateDir);
  // Ryan's writes go through his own gh login (F21), never the bot's.
  const own = createGh({
    exec: nodeExec,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '' },
  });
  const login = (await own.run(['api', 'user', '--jq', '.login']).catch(() => '')).trim();
  const writer = login === config.owner ? createWriter(config, own) : undefined;
  if (!writer)
    log(`Read-only: your gh is signed in as "${login || 'nobody'}", not ${config.owner}.`);
  let board: { at: number; value: Board } | undefined;
  const view = async (): Promise<FactoryView> => {
    // The board costs a GitHub query; once every 30 s is plenty.
    if (!board || Date.now() - board.at > 30_000)
      board = { at: Date.now(), value: await readBoard(gh, config) };
    const ledgerPath = join(state, 'runs.jsonl');
    const statusPath = join(state, 'status.json');
    let daemon: { pid: number; updatedAt: string } | null = null;
    try {
      daemon = JSON.parse(readFileSync(statusPath, 'utf8')) as { pid: number; updatedAt: string };
    } catch {
      // Not run yet.
    }
    return buildView({
      config,
      board: board.value,
      ledger: existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '',
      plans: readPlans(config),
      busySessions: await busySessions(config),
      daemon,
      now: new Date(),
      writable: !!writer,
    });
  };
  const token = randomBytes(24).toString('hex');
  const server = createUiServer({
    port: config.ui.port,
    token,
    page: pageHtml,
    view,
    ...(writer ? { writer } : {}),
  });
  const port = await listen(server, config.ui.port);
  const link = `http://127.0.0.1:${port}/?token=${token}`;
  writeFileSync(uiLinkPath(config), `${link}\n`, { mode: 0o600 });
  log(`Factory UI: ${link}`);
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  writeFileSync(uiLinkPath(config), '', { mode: 0o600 });
  return 0;
}
