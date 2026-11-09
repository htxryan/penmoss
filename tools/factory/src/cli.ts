/**
 * The factory's command line: `node tools/factory/src/cli.ts <command>`.
 * Taskfile tasks wrap each command (`task factory:next`).
 */
import { fileURLToPath } from 'node:url';
import { loadConfig, type FactoryConfig } from './config.ts';
import { baseNote, hostChecks, report } from './doctor.ts';
import { runDoctor } from './doctor-run.ts';
import { nodeExec } from './exec.ts';
import { createGh } from './github.ts';
import { pickNext, priorityName, type Pick } from './pick.ts';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome } from './config.ts';
import {
  agentPath,
  codeDir,
  installAgents,
  startFactory,
  updateFactory,
  type AgentDeps,
} from './code.ts';
import { runDaemon } from './daemon.ts';
import { formatStatus, readStatus } from './status.ts';
import { buildReport, formatReport, parseRange } from './report.ts';
import { planningChat } from './planning-host.ts';
import { startRun } from './start.ts';
import { runUi } from './ui/run.ts';
import { appClient, openTracker } from './tracker/index.ts';
import { fix, snapshot, teamNeeds } from './tracker/linear-check.ts';
import { createLinearClient, type LinearClient } from './tracker/linear-client.ts';
import { ownerKey } from './ui/owner.ts';
import { decisionNumber } from './decision-number.ts';
import { helpFor, usage } from './usage.ts';

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
    console.log(
      `\nThen: ${rest.map((p) => `${p.item.key} (${priorityName(p, config)})`).join(', ')}`,
    );
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
  // Every check runs with the PATH the LaunchAgents run with, not this shell's: Sandcastle gives
  // the sandbox this process's PATH, as it does a run's (PEN-75's `claude` was on the shell's only).
  const path = agentPath(config, homedir(), process.execPath);
  process.env['PATH'] = path;
  console.log(
    `Doctor: slot ${slot.id} (port block ${slot.portBlock}, ${slot.avd}) on a throwaway branch of ${base}, with the LaunchAgent's PATH ${path}`,
  );
  const note = await baseNote(nodeExec, repo, base);
  if (note) console.log(`  ${note}`);
  const host = hostChecks(config, path);
  const outcomes = [
    ...host,
    ...(await runDoctor(config, slot, {
      repo,
      full: args.includes('--full') || args.includes('--only'),
      base,
      ...(args.includes('--only') ? { only: args[args.indexOf('--only') + 1] ?? '' } : {}),
      exec: nodeExec,
      log: (line) => console.log(`  ${line}`),
    })),
  ];
  console.log(`\n${report(outcomes)}`);
  if (note) console.log(note);
  return outcomes.some((o) => o.status === 'failed') ? 1 : 0;
}

function agentDeps(): AgentDeps {
  return {
    exec: nodeExec,
    home: homedir(),
    uid: String(process.getuid?.() ?? 501),
    node: process.execPath,
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function update(config: FactoryConfig, args: readonly string[]): Promise<number> {
  return updateFactory(
    config,
    {
      ...agentDeps(),
      pid: process.pid,
      alive: isAlive,
      now: () => new Date(),
    },
    { wait: args.includes('--wait') },
  );
}

function status(config: FactoryConfig): number {
  const s = readStatus(config);
  if (!s) {
    console.log('The daemon has not run yet (task factory:install).');
    return 1;
  }
  console.log(formatStatus(s, config, codeDir(config), new Date(), isAlive).join('\n'));
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

/** `factory chat <issue>`: the planning session's chat, the same one Remote Control serves (F15). */
async function chat(config: FactoryConfig, args: readonly string[]): Promise<number> {
  const number = Number(args[0]);
  if (!Number.isInteger(number) || number < 1) {
    console.error('Usage: factory chat <issue> [--print]');
    return 2;
  }
  const found = planningChat(config, number);
  if ('error' in found) {
    console.error(`${found.error}.`);
    return 1;
  }
  console.log(`Chat: ${found.chatUrl}`);
  if (found.desktop) console.log(`In the Claude app: ${found.desktop}`);
  console.log(
    'While the card is Blocked the session is stopped; clearing Blocked resumes it with a new link.',
  );
  if (args.includes('--print')) return 0;
  const opened = await nodeExec('open', [found.desktop ?? found.chatUrl]);
  return opened.code === 0 ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  // Before anything else, the config included: `doctor --help` ran the doctor (PEN-70's run).
  const help = helpFor(argv);
  if (help !== undefined) {
    console.log(help);
    return 0;
  }
  const loaded = loadConfig();
  if (!loaded.ok) {
    console.error(`factory: ${loaded.error}`);
    return 2;
  }
  switch (command) {
    case 'next':
      return next(loaded.config, rest.includes('--json'));
    case 'install':
      return installAgents(loaded.config, agentDeps());
    case 'update':
      return update(loaded.config, rest);
    case 'start':
      return startFactory(agentDeps());
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
    case 'chat':
      return chat(loaded.config, rest);
    case 'decision-number':
      return decisionNumber(loaded.config, rest, {
        exec: nodeExec,
        repo: process.cwd(),
        log: (line) => console.log(line),
      });
    case undefined:
      console.log(usage());
      return 2;
    default:
      console.error(`factory: unknown command "${command}"\n\n${usage()}`);
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
