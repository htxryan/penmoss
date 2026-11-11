/**
 * Planning sessions on this Mac (F15/F16): one background `claude --bg --remote-control`
 * session per issue, run from `<stateDir>/plans` (trusted once, docs/factory.md), reading a
 * snapshot of main and writing only its own output folder. Issue comments reach it by stop and
 * resume (F0.5); the dispatcher keeps its session ID, its chat link and what it has delivered.
 * It runs on Ryan's own Claude.ai login, never the factory's setup token, so Remote Control can
 * serve its chat in the Claude app (A1286, amending A1281).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTACHMENTS } from './attachments.ts';
import { expandHome, type FactoryConfig } from './config.ts';
import type { Exec } from './exec.ts';
import { attachCommand, parsePlanState, type PlanState } from './planning.ts';
import { mustGit } from './git.ts';
import { MAIN, publishDir } from './publish.ts';
import { issueKey } from './tracker/port.ts';

export interface PlanFiles {
  readonly root: string;
  readonly repo: string;
  readonly out: string;
  readonly meta: string;
  /** The issue's images, which the host downloads (attachments.ts): the session only reads them. */
  readonly attachments: string;
}

export interface PlanMeta {
  readonly sessionId?: string | undefined;
  /** The session's chat on claude.ai, which Remote Control serves; each resume gets a new one. */
  readonly chatUrl?: string | undefined;
  /** When the newest issue comment the session has been given was posted. */
  readonly deliveredAt?: string | undefined;
  /** When the factory last started or resumed the session. */
  readonly messagedAt?: string | undefined;
  /** When the factory last posted open points and set Blocked; cleared on resume. */
  readonly askedAt?: string | undefined;
  /** Set once planning ends: Ryan's yes, or the agent's reason the issue is trivial. */
  readonly agreed?: {
    readonly quote: string;
    readonly channel: string;
    readonly at: string;
    readonly trivial: boolean;
    /** The artifacts and versions Ryan agreed to (F16); null when unknown or trivial. */
    readonly planUrl?: string | null;
    readonly designUrl?: string | null;
    readonly planVersion?: number | null;
    readonly designVersion?: number | null;
  };
  /** How many times the session was sent back to fix the plan contract (F16). */
  readonly contractFixes?: number | undefined;
}

/** The session's name in `claude agents` and the Claude app: the card as people know it. */
export const sessionName = (config: FactoryConfig, issue: number) =>
  `Penmoss ${issueKey(config, issue)} plan`;

/** The card a session name belongs to, or `undefined` for any other session. */
export function sessionIssue(config: FactoryConfig, name: string | undefined): number | undefined {
  const n = Number(/^Penmoss (?:#|[A-Z][A-Z0-9]*-)(\d+) plan$/.exec(name ?? '')?.[1]);
  return Number.isInteger(n) && name === sessionName(config, n) ? n : undefined;
}

export function planFiles(config: FactoryConfig, issue: number): PlanFiles {
  const root = join(expandHome(config.stateDir), 'plans', String(issue));
  return {
    root,
    repo: join(root, 'repo'),
    out: join(root, 'out'),
    meta: join(root, 'meta.json'),
    attachments: join(root, ATTACHMENTS),
  };
}

export function readMeta(files: PlanFiles): PlanMeta {
  try {
    return JSON.parse(readFileSync(files.meta, 'utf8')) as PlanMeta;
  } catch {
    return {};
  }
}

export function writeMeta(files: PlanFiles, meta: PlanMeta): void {
  writeFileSync(files.meta, JSON.stringify(meta, null, 2));
}

export function readState(files: PlanFiles): { state: PlanState; writtenAt: Date } | null {
  const path = join(files.out, 'state.json');
  if (!existsSync(path)) return null;
  const state = parsePlanState(readFileSync(path, 'utf8'));
  return state ? { state, writtenAt: statSync(path).mtime } : null;
}

/** The agreed plan, kept beside the session's output so a later revision can't change it. */
export const agreedPlanPath = (files: PlanFiles) => join(files.root, 'agreed.html');

/** The flags every planning session runs with (F0.5): no MCP, no Chrome, project settings, path-scoped tools. */
export function planningFlags(files: PlanFiles): string[] {
  return [
    '--no-chrome',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--setting-sources',
    'project',
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    'Artifact',
    'ArtifactComments',
    under('Read', files.repo),
    under('Read', files.out),
    under('Read', files.attachments),
    under('Edit', files.out),
  ];
}

/**
 * A permission rule for everything under an absolute folder. Claude Code reads `/path` in a rule
 * as relative to the settings file and `//path` as absolute, and matches file writes only against
 * `Edit` rules, never `Write`. PEN-70's planning session ran with `Write(/Users/…/out/**)`,
 * which matched nothing: every write of its state file was refused, and the factory saw it stuck.
 */
export const under = (tool: 'Read' | 'Edit', dir: string): string =>
  `${tool}(/${dir.replace(/\/+$/, '')}/**)`;

/**
 * A fresh snapshot of main for the session to explore: main's files, exported from the publish
 * repo (`git archive`), with no `.git`. git never runs in the runs' clone (A1230); a snapshot
 * an older factory made as a worktree of that clone is deleted, and the janitor drops its record.
 */
export async function prepareSnapshot(
  config: FactoryConfig,
  files: PlanFiles,
  exec: Exec,
): Promise<void> {
  mkdirSync(files.out, { recursive: true });
  rmSync(files.repo, { recursive: true, force: true });
  mkdirSync(files.repo, { recursive: true });
  const tar = join(files.root, 'main.tar');
  try {
    await mustGit(exec, publishDir(config), ['archive', '--format=tar', `--output=${tar}`, MAIN]);
    const unpacked = await exec('tar', ['-x', '-f', tar, '-C', files.repo]);
    if (unpacked.code !== 0) throw new Error(unpacked.stderr.trim());
  } catch (error) {
    throw new Error(
      `couldn't make the planning snapshot: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    rmSync(tar, { force: true });
  }
}

const CHAT_URL = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/;

export interface SessionInfo {
  readonly sessionId: string;
  /** The short id `claude --bg` prints, which `claude stop`, `logs` and `attach` take. */
  readonly id: string;
  readonly status: string;
}

/** The short id in `claude --bg`'s "backgrounded · <id> · <name>" line. */
const BACKGROUNDED = /backgrounded\s*·\s*([0-9a-f]{6,})\b/;

/**
 * The background session for an issue, from `claude agents --json`: the one with the id or
 * session id given, else the one with the card's name. Claude Code may retitle a session it
 * names itself, so the factory finds its own by id (PEN-70's planning, 9 Nov 2026).
 */
export async function findSession(
  config: FactoryConfig,
  exec: Exec,
  issue: number,
  env: Record<string, string>,
  known: { readonly id?: string | undefined; readonly sessionId?: string | undefined } = {},
): Promise<SessionInfo | undefined> {
  const r = await exec(config.agents.claude.bin, ['agents', '--json'], { env });
  if (r.code !== 0) return undefined;
  const sessions = (
    JSON.parse(r.stdout || '[]') as {
      id?: string;
      name?: string;
      sessionId: string;
      status: string;
      kind: string;
    }[]
  ).filter((s) => s.kind !== 'interactive');
  const found =
    (known.id && sessions.find((s) => s.id === known.id)) ||
    (known.sessionId && sessions.find((s) => s.sessionId === known.sessionId)) ||
    sessions.find((s) => s.name === sessionName(config, issue));
  if (!found) return undefined;
  return {
    sessionId: found.sessionId,
    id: found.id ?? found.sessionId.slice(0, 8),
    status: found.status,
  };
}

/**
 * Claude Code's folder of background jobs, one `<short id>/state.json` each, under its config
 * folder (`CLAUDE_CONFIG_DIR`, else `~/.claude`). Undefined without a home to find it in.
 */
export function claudeJobsDir(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (env['CLAUDE_CONFIG_DIR']) return join(env['CLAUDE_CONFIG_DIR'], 'jobs');
  return env['HOME'] ? join(env['HOME'], '.claude', 'jobs') : undefined;
}

const BRIDGE_ID = /^(?:cse|session)_([A-Za-z0-9_-]{1,128})$/;

/**
 * The chat link of a background session, from its job's state.json: `bridgeSessionId` is its
 * Remote Control session (`cse_…`), which claude.ai serves as `code/session_…`, the same id
 * with Claude Code's own `session_` prefix. `claude --bg` prints no link, and `claude agents
 * --json` has no field for one (PEN-70's run, A1257).
 */
export function chatUrlFromJob(stateJson: string): string | undefined {
  try {
    const id = (JSON.parse(stateJson) as { bridgeSessionId?: unknown }).bridgeSessionId;
    const m = typeof id === 'string' ? BRIDGE_ID.exec(id) : null;
    return m ? `https://claude.ai/code/session_${m[1]}` : undefined;
  } catch {
    return undefined;
  }
}

export interface JobOptions {
  /** Claude Code's jobs folder; `claudeJobsDir(env)` when absent. */
  readonly dir?: string | undefined;
  /** How long to wait for the session's Remote Control link (default 20 s). */
  readonly waitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The job's chat link, once Claude Code has written it (a few seconds after `--bg` returns). */
export async function waitForChatUrl(
  dir: string,
  id: string,
  options: JobOptions = {},
): Promise<string | undefined> {
  if (!/^[0-9a-f]{6,}$/.test(id)) return undefined;
  const file = join(dir, id, 'state.json');
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const step = 1_000;
  for (let waited = 0; ; waited += step) {
    const url = existsSync(file) ? chatUrlFromJob(readFileSync(file, 'utf8')) : undefined;
    if (url || waited >= (options.waitMs ?? 20_000)) return url;
    await sleep(step);
  }
}

/**
 * The environment a planning session runs in: the daemon's own PATH and HOME, so `claude` signs
 * in with Ryan's own Claude.ai login (its keychain entry), which can open Remote Control. The
 * factory's setup token, or an API key, would sign it in instead, and Claude.ai rejects those for
 * Remote Control, so neither is ever passed (A1286, amending A1281). Implementation runs keep the
 * token, in the sandbox.
 */
export function planningEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return {
    PATH: env['PATH'] ?? '/usr/bin:/bin',
    HOME: env['HOME'] ?? '',
    // The keychain entry Claude Code keeps the login in is the user's (launchd sets USER).
    ...(env['USER'] ? { USER: env['USER'] } : {}),
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  };
}

/** Starts (or resumes) the session in the background; returns its short id and chat link. */
export async function launchSession(
  config: FactoryConfig,
  exec: Exec,
  files: PlanFiles,
  issue: number,
  message: string,
  env: Record<string, string>,
  resume?: string,
  jobs: JobOptions = {},
): Promise<{ id?: string; chatUrl?: string }> {
  const cwd = join(expandHome(config.stateDir), 'plans');
  const args = [
    ...(resume ? ['--resume', resume] : []),
    '--bg',
    // The display name `claude agents` shows; without it Claude Code titles the session itself.
    '--name',
    sessionName(config, issue),
    // Its chat in the Claude app and on claude.ai, which needs Ryan's own login (planningEnv).
    '--remote-control',
    sessionName(config, issue),
    ...planningFlags(files),
    '--',
    message,
  ];
  const r = await exec(config.agents.claude.bin, args, { cwd, env });
  if (r.code !== 0)
    throw new Error(
      `claude --bg failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`,
    );
  const id = BACKGROUNDED.exec(r.stdout + r.stderr)?.[1];
  const dir = jobs.dir ?? claudeJobsDir(env);
  const chatUrl =
    CHAT_URL.exec(r.stdout + r.stderr)?.[0] ??
    (id && dir ? await waitForChatUrl(dir, id, jobs) : undefined);
  return { ...(id ? { id } : {}), ...(chatUrl ? { chatUrl } : {}) };
}

export async function stopSession(
  config: FactoryConfig,
  exec: Exec,
  issue: number,
  sessionId: string,
  env: Record<string, string>,
): Promise<void> {
  // `claude stop` takes the short id, not the session id.
  const found = await findSession(config, exec, issue, env, { sessionId });
  await exec(config.agents.claude.bin, ['stop', found?.id ?? sessionId.slice(0, 8)], { env });
}

/**
 * `factory chat <n>` (F15): the card's planning session's chat in the Claude app, when Remote
 * Control gave it one, and the command that joins it from a terminal on this Mac (attachCommand).
 */
export function planningChat(
  config: FactoryConfig,
  issue: number,
): { readonly command: string; readonly chatUrl: string | null } | { readonly error: string } {
  const meta = readMeta(planFiles(config, issue));
  if (!meta.sessionId) return { error: `${issueKey(config, issue)} has no planning session yet` };
  if (meta.agreed)
    return { error: `${issueKey(config, issue)}'s plan is agreed; its planning session has ended` };
  return { command: attachCommand(meta.sessionId), chatUrl: meta.chatUrl ?? null };
}

/** The agreed plan as text for the implementation prompt: the page's words without its markup. */
export function planText(html: string): string {
  return html
    .replaceAll(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, '')
    .replaceAll(/<\/(p|div|section|h[1-6]|li|tr|table|ul|ol|pre)>/gi, '\n')
    .replaceAll(/<br\s*\/?>/gi, '\n')
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll(/[ \t]+/g, ' ')
    .replaceAll(/\n\s*\n+/g, '\n\n')
    .trim();
}
