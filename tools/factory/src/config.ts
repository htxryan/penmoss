/**
 * The factory's configuration (`tools/factory/factory.config.json`): which
 * board it watches, the status names it moves cards between, its slots and
 * its model aliases. Parsed once at start; a bad file is a typed error, never
 * a half-read config.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AgentName = 'claude' | 'opencode';
export type Platform = 'web' | 'mac' | 'android';

export const PLATFORMS: readonly Platform[] = ['web', 'mac', 'android'];

export interface SlotConfig {
  readonly id: number;
  readonly portBlock: number;
  readonly avd: string;
  readonly emulatorPort: number;
  readonly adbServerPort: number;
}

export interface ModelAlias {
  readonly agent: AgentName;
  readonly model: string;
}

export interface FactoryConfig {
  /** `owner/name` of the repository whose issues the factory works on. */
  readonly repo: string;
  readonly project: { readonly owner: string; readonly number: number };
  /** The only login whose comments count as instructions (R14). */
  readonly owner: string;
  readonly status: {
    readonly pick: string;
    readonly planning: string;
    readonly working: string;
    readonly review: string;
    readonly done: string;
  };
  /** The project's single-select field that means "waiting on Ryan" (R23). */
  readonly blockedField: string;
  readonly planning: {
    readonly default: boolean;
    readonly skipLabel: string;
    readonly agentMaySkipTrivial: boolean;
    readonly designWhenUx: boolean;
  };
  readonly review: { readonly commentQuietMinutes: number; readonly validationRounds: number };
  readonly publisher: { readonly login: string; readonly ghConfigDir: string };
  readonly envFile: string;
  readonly stateDir: string;
  readonly pollSeconds: number;
  readonly maxConcurrent: number;
  readonly worktreeRoot: string;
  readonly branchPrefix: string;
  readonly rounds: { readonly gateFix: number; readonly ciRepair: number };
  readonly timeouts: {
    readonly agentMinutes: number;
    readonly proofMinutes: number;
    readonly ciMinutes: number;
  };
  readonly slots: readonly SlotConfig[];
  readonly sharedDir: string;
  readonly macProof: { readonly task: string; readonly vm: string; readonly lock: string };
  readonly agents: Readonly<
    Record<AgentName, { readonly bin: string; readonly defaultModel: string }>
  >;
  readonly models: Readonly<Record<string, ModelAlias>>;
  readonly ui: { readonly port: number; readonly doneDays: number };
  /** Host toolchains mounted read-only into every sandbox (F17). */
  readonly toolchain: {
    readonly jdk: string;
    readonly androidSdk: string;
    readonly playwrightBrowsers: string;
  };
}

export type ConfigResult =
  | { readonly ok: true; readonly config: FactoryConfig }
  | { readonly ok: false; readonly error: string };

export const DEFAULT_CONFIG_PATH = new URL('../factory.config.json', import.meta.url);

/** Expands a leading `~/` to the home folder; other paths are returned as they are. */
export function expandHome(path: string, home: string = homedir()): string {
  return path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

export function loadConfig(path: string | URL = DEFAULT_CONFIG_PATH): ConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { ok: false, error: `can't read ${String(path)}: ${(error as Error).message}` };
  }
  return parseConfig(raw);
}

/** Checks the shape of a parsed config file and names the first problem it finds. */
export function parseConfig(raw: unknown): ConfigResult {
  const problems: string[] = [];
  const obj = (value: unknown, at: string): Record<string, unknown> => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    problems.push(`${at} must be an object`);
    return {};
  };
  const str = (o: Record<string, unknown>, key: string, at: string): void => {
    if (typeof o[key] !== 'string' || o[key] === '')
      problems.push(`${at}.${key} must be a non-empty string`);
  };
  const int = (o: Record<string, unknown>, key: string, at: string, min = 0): void => {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
      problems.push(`${at}.${key} must be an integer of at least ${min}`);
    }
  };
  const bool = (o: Record<string, unknown>, key: string, at: string): void => {
    if (typeof o[key] !== 'boolean') problems.push(`${at}.${key} must be true or false`);
  };

  const root = obj(raw, 'config');
  str(root, 'repo', 'config');
  if (typeof root['repo'] === 'string' && !/^[\w.-]+\/[\w.-]+$/.test(root['repo'])) {
    problems.push('config.repo must look like owner/name');
  }
  const project = obj(root['project'], 'config.project');
  str(project, 'owner', 'config.project');
  int(project, 'number', 'config.project', 1);
  str(root, 'owner', 'config');
  const status = obj(root['status'], 'config.status');
  for (const key of ['pick', 'planning', 'working', 'review', 'done'])
    str(status, key, 'config.status');
  str(root, 'blockedField', 'config');
  const planning = obj(root['planning'], 'config.planning');
  for (const key of ['default', 'agentMaySkipTrivial', 'designWhenUx'])
    bool(planning, key, 'config.planning');
  str(planning, 'skipLabel', 'config.planning');
  const review = obj(root['review'], 'config.review');
  int(review, 'commentQuietMinutes', 'config.review');
  int(review, 'validationRounds', 'config.review');
  const publisher = obj(root['publisher'], 'config.publisher');
  str(publisher, 'login', 'config.publisher');
  str(publisher, 'ghConfigDir', 'config.publisher');
  for (const key of ['envFile', 'stateDir', 'worktreeRoot', 'branchPrefix', 'sharedDir'])
    str(root, key, 'config');
  int(root, 'pollSeconds', 'config', 10);
  int(root, 'maxConcurrent', 'config', 1);
  const rounds = obj(root['rounds'], 'config.rounds');
  int(rounds, 'gateFix', 'config.rounds');
  int(rounds, 'ciRepair', 'config.rounds');
  const timeouts = obj(root['timeouts'], 'config.timeouts');
  for (const key of ['agentMinutes', 'proofMinutes', 'ciMinutes'])
    int(timeouts, key, 'config.timeouts', 1);
  if (!Array.isArray(root['slots']) || root['slots'].length === 0) {
    problems.push('config.slots must be a non-empty list');
  } else {
    root['slots'].forEach((slot, i) => {
      const s = obj(slot, `config.slots[${i}]`);
      for (const key of ['id', 'portBlock', 'emulatorPort', 'adbServerPort'])
        int(s, key, `config.slots[${i}]`, 1);
      str(s, 'avd', `config.slots[${i}]`);
    });
  }
  const macProof = obj(root['macProof'], 'config.macProof');
  for (const key of ['task', 'vm', 'lock']) str(macProof, key, 'config.macProof');
  const agents = obj(root['agents'], 'config.agents');
  for (const name of ['claude', 'opencode']) {
    const agent = obj(agents[name], `config.agents.${name}`);
    str(agent, 'bin', `config.agents.${name}`);
    str(agent, 'defaultModel', `config.agents.${name}`);
  }
  const models = obj(root['models'], 'config.models');
  for (const [alias, value] of Object.entries(models)) {
    const m = obj(value, `config.models.${alias}`);
    if (m['agent'] !== 'claude' && m['agent'] !== 'opencode') {
      problems.push(`config.models.${alias}.agent must be claude or opencode`);
    }
    str(m, 'model', `config.models.${alias}`);
  }
  for (const name of ['claude', 'opencode'] as const) {
    const alias =
      (obj(agents[name], `config.agents.${name}`)['defaultModel'] as string | undefined) ?? '';
    const target = models[alias] as { agent?: unknown } | undefined;
    if (alias && (!target || target.agent !== name)) {
      problems.push(
        `config.agents.${name}.defaultModel must name a ${name} alias in config.models`,
      );
    }
  }
  const ui = obj(root['ui'], 'config.ui');
  int(ui, 'port', 'config.ui', 1024);
  int(ui, 'doneDays', 'config.ui', 1);
  const toolchain = obj(root['toolchain'], 'config.toolchain');
  for (const key of ['jdk', 'androidSdk', 'playwrightBrowsers'])
    str(toolchain, key, 'config.toolchain');

  const [first] = problems;
  return first === undefined
    ? { ok: true, config: raw as FactoryConfig }
    : { ok: false, error: first };
}
