/**
 * The factory's command line: `node tools/factory/src/cli.ts <command>`.
 * Taskfile tasks wrap each command (`task factory:next`).
 */
import { fileURLToPath } from 'node:url';
import { loadConfig, type FactoryConfig } from './config.ts';
import { report } from './doctor.ts';
import { runDoctor } from './doctor-run.ts';
import { nodeExec } from './exec.ts';
import { createGh } from './github.ts';
import { pickNext, type Pick } from './pick.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expandHome } from './config.ts';
import { runDaemon } from './daemon.ts';
import { LABEL, plistPath, renderPlist, UI_LABEL } from './launchd.ts';
import { buildReport, formatReport, parseRange } from './report.ts';
import { startRun } from './start.ts';
import { runUi } from './ui/run.ts';
import { appClient, openTracker } from './tracker/index.ts';
import { fix, snapshot, teamNeeds } from './tracker/linear-check.ts';
import { createLinearClient, type LinearClient } from './tracker/linear-client.ts';
import { ownerKey } from './ui/owner.ts';
import { issueKey } from './tracker/port.ts';

const USAGE = `Usage: factory <command>

Commands:
  next [--json]             Print the Ready card the factory would start next, and why (read-only)
  install                   Install and start the LaunchAgents that run the daemon and the UI at login
  status                    What the daemon is running, waiting on and passing over
  daemon                    Poll the board and run Ready cards in free slots (the LaunchAgent runs this)
  ui                        Serve the Factory UI on 127.0.0.1 (its LaunchAgent runs this)
  report [--from d] [--to d] Throughput, rounds, time to In review and the share Blocked (default: 7 days)
  run <issue> [--slot n]    Run one Ready issue now, in the foreground (plan:skip issues until planning lands)
  linear-check [--me] [--fix]
                            Check Linear's team has the factory's states and labels (--me: print
                            Ryan's user ID with his key; --fix: create what's missing, as Ryan)
  doctor [--slot n] [--full] [--base ref] [--only name]
                            Check a slot's sandbox: toolchain, tokens, and what must stay out`;

function describe(pick: Pick, config: FactoryConfig): string[] {
  const { item, spec } = pick;
  const scope = spec.platforms
    ? `${spec.platforms.join(', ')} (from platform:* labels)`
    : 'decided by the path classifier once the diff exists';
  return [
    `${item.key} ${item.title}`,
    `  ${item.url}`,
    `  why:      ${pick.why}`,
    `  agent:    ${spec.agent} (${config.agents[spec.agent].bin}), model ${spec.modelAlias} = ${spec.model}`,
    `  phase:    ${pick.mode === 'plan' ? `plan first (card moves to ${config.status.planning})` : `implement, planning skipped (card moves to ${config.status.working})`}`,
    `  scope:    ${scope}`,
  ];
}

async function next(config: FactoryConfig, json: boolean): Promise<number> {
  // Read-only: GitHub through your own gh, Linear as the factory app.
  const opened = await openTracker(config, createGh({ exec: nodeExec }));
  if (!opened.ok) {
    console.error(`Can't read the board: ${opened.error}.`);
    return 2;
  }
  const board = await opened.tracker.readBoard();
  const result = pickNext(board.items, config);
  if (json) {
    console.log(
      JSON.stringify(
        {
          next: result.next && {
            number: result.next.item.number,
            key: result.next.item.key,
            mode: result.next.mode,
            why: result.next.why,
            spec: result.next.spec,
          },
          queue: result.queue.map((p) => p.item.number),
          skipped: result.skipped.map((s) => ({ number: s.item.number, reason: s.reason })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (result.next) {
    console.log(['Next:', ...describe(result.next, config)].join('\n'));
  } else {
    console.log(`Nothing in ${config.status.pick} can start.`);
  }
  const rest = result.queue.slice(1);
  if (rest.length > 0) {
    console.log(`\nThen: ${rest.map((p) => `${p.item.key} (P${p.spec.priority})`).join(', ')}`);
  }
  if (result.skipped.length > 0) {
    console.log(
      `\nPassed over:\n${result.skipped.map((s) => `  ${s.item.key} ${s.item.title}: ${s.reason}`).join('\n')}`,
    );
  }
  return 0;
}

async function doctor(config: FactoryConfig, args: readonly string[]): Promise<number> {
  const slotArg = args[args.indexOf('--slot') + 1];
  const id = args.includes('--slot') ? Number(slotArg) : (config.slots[0]?.id ?? 1);
  const slot = config.slots.find((s) => s.id === id);
  if (!slot) {
    console.error(
      `factory: no slot ${String(slotArg)} (slots: ${config.slots.map((s) => s.id).join(', ')})`,
    );
    return 2;
  }
  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  const base = args.includes('--base')
    ? (args[args.indexOf('--base') + 1] ?? 'origin/main')
    : 'origin/main';
  console.log(
    `Doctor: slot ${slot.id} (port block ${slot.portBlock}, ${slot.avd}) on a throwaway branch of ${base}`,
  );
  const outcomes = await runDoctor(config, slot, {
    repo,
    full: args.includes('--full') || args.includes('--only'),
    base,
    ...(args.includes('--only') ? { only: args[args.indexOf('--only') + 1] ?? '' } : {}),
    exec: nodeExec,
    log: (line) => console.log(`  ${line}`),
  });
  console.log(`\n${report(outcomes)}`);
  return outcomes.some((o) => o.status === 'failed') ? 1 : 0;
}

async function install(config: FactoryConfig): Promise<number> {
  const state = expandHome(config.stateDir);
  mkdirSync(state, { recursive: true });
  const cli = fileURLToPath(import.meta.url);
  const uid = String(process.getuid?.() ?? 501);
  for (const [label, command, logName] of [
    [LABEL, 'daemon', 'daemon.log'],
    [UI_LABEL, 'ui', 'ui.log'],
  ] as const) {
    const plist = plistPath(homedir(), label);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(
      plist,
      renderPlist({
        label,
        command,
        node: process.execPath,
        cli,
        repo: fileURLToPath(new URL('../../..', import.meta.url)),
        path: [
          dirname(process.execPath),
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
        ].join(':'),
        log: join(state, logName),
      }),
    );
    await nodeExec('launchctl', ['bootout', `gui/${uid}/${label}`]);
    const loaded = await nodeExec('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    if (loaded.code !== 0) {
      console.error(`launchctl bootstrap ${label} failed: ${loaded.stderr.trim()}`);
      return 1;
    }
    console.log(`Installed ${plist}`);
  }
  console.log(
    'The daemon and the UI start now and at every login. Logs: task factory:logs; the UI: task factory:ui:open',
  );
  return 0;
}

function status(config: FactoryConfig): number {
  const file = join(expandHome(config.stateDir), 'status.json');
  if (!existsSync(file)) {
    console.log('The daemon has not run yet (task factory:install).');
    return 1;
  }
  const s = JSON.parse(readFileSync(file, 'utf8')) as {
    updatedAt: string;
    pid: number;
    running: { issue: number; slot: number; startedAt: string; why: string }[];
    waiting: number[];
    skipped: { issue: number; reason: string }[];
  };
  const age = Math.round((Date.now() - Date.parse(s.updatedAt)) / 1000);
  console.log(
    `Daemon ${s.pid}, last poll ${age} s ago${age > config.pollSeconds * 3 ? ' (stale: is it running? task factory:logs)' : ''}.`,
  );
  console.log(
    s.running.length
      ? s.running
          .map(
            (r) =>
              `  running ${issueKey(config, r.issue)} on slot ${r.slot} since ${r.startedAt} (${r.why})`,
          )
          .join('\n')
      : '  nothing running',
  );
  if (s.waiting.length)
    console.log(`  waiting for a slot: ${s.waiting.map((n) => issueKey(config, n)).join(', ')}`);
  for (const k of s.skipped) console.log(`  passed over ${issueKey(config, k.issue)}: ${k.reason}`);
  return 0;
}

async function linearCheck(config: FactoryConfig, args: readonly string[]): Promise<number> {
  const asRyan = args.includes('--me') || args.includes('--fix');
  let client: LinearClient;
  if (asRyan) {
    const key = await ownerKey(config);
    if (!key) {
      console.error(
        `No Linear key in the keychain item ${config.linear.keychainItem}. Make one in Linear (Settings, Security & access, Personal API keys), then: security add-generic-password -s ${config.linear.keychainItem} -a "$USER" -w`,
      );
      return 2;
    }
    client = createLinearClient({ token: () => Promise.resolve(key) });
  } else {
    const app = appClient(config);
    if (!app.ok) {
      console.error(`${app.error}. Use --me to check with your own key instead.`);
      return 2;
    }
    client = app.client;
  }
  if (args.includes('--me')) {
    const { viewer } = await client.request<{ viewer: { id: string; displayName: string } }>(
      'query { viewer { id displayName } }',
    );
    console.log(`You are ${viewer.displayName}: ${viewer.id}`);
    console.log(
      viewer.id === config.linear.owner
        ? 'config.linear.owner matches.'
        : `Set config.linear.owner in tools/factory/factory.config.json to "${viewer.id}".`,
    );
  }
  if (args.includes('--fix')) await fix(client, config, (line) => console.log(line));
  const needs = teamNeeds(await snapshot(client, config), config);
  if (needs.length === 0) {
    console.log(`Linear's ${config.linear.team} team is ready for the factory.`);
    return 0;
  }
  console.log(`Linear's ${config.linear.team} team still needs:`);
  for (const n of needs) console.log(`  - ${n.text}`);
  return 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const loaded = loadConfig();
  if (!loaded.ok) {
    console.error(`factory: ${loaded.error}`);
    return 2;
  }
  switch (command) {
    case 'next':
      return next(loaded.config, rest.includes('--json'));
    case 'install':
      return install(loaded.config);
    case 'status':
      return status(loaded.config);
    case 'daemon':
      return runDaemon(loaded.config, (line) => console.log(`${new Date().toISOString()} ${line}`));
    case 'report': {
      const range = parseRange(rest, new Date());
      if ('error' in range) {
        console.error(`factory report: ${range.error}`);
        return 2;
      }
      const ledger = join(expandHome(loaded.config.stateDir), 'runs.jsonl');
      console.log(
        formatReport(
          buildReport(existsSync(ledger) ? readFileSync(ledger, 'utf8') : '', range.from, range.to),
        ),
      );
      return 0;
    }
    case 'ui':
      return runUi(loaded.config, (line) => console.log(`${new Date().toISOString()} ${line}`));
    case 'run':
      return startRun(loaded.config, rest, (line) => console.log(line));
    case 'doctor':
      return doctor(loaded.config, rest);
    case 'linear-check':
      return linearCheck(loaded.config, rest);
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return command === undefined ? 2 : 0;
    default:
      console.error(`factory: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`factory: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
