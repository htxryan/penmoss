/**
 * Planning sessions on this Mac (F15/F16): one background `claude --bg --remote-control`
 * session per issue, run from `<stateDir>/plans` (trusted once, docs/factory.md), reading a
 * snapshot of main and writing only its own output folder. Issue comments reach it by stop and
 * resume (F0.5); the dispatcher keeps its session ID, its chat link and what it has delivered.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig } from './config.ts';
import type { Exec } from './exec.ts';
import { parsePlanState, type PlanState } from './planning.ts';
import { repoDir } from './host.ts';

export interface PlanFiles {
  readonly root: string;
  readonly repo: string;
  readonly out: string;
  readonly meta: string;
}

export interface PlanMeta {
  readonly sessionId?: string | undefined;
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

export const sessionName = (issue: number) => `Penmoss #${issue} plan`;

export function planFiles(config: FactoryConfig, issue: number): PlanFiles {
  const root = join(expandHome(config.stateDir), 'plans', String(issue));
  return { root, repo: join(root, 'repo'), out: join(root, 'out'), meta: join(root, 'meta.json') };
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
    `Read(${files.repo}/**)`,
    `Read(${files.out}/**)`,
    `Edit(${files.out}/**)`,
    `Write(${files.out}/**)`,
  ];
}

/** A fresh read-only snapshot of main for the session to explore. */
export async function prepareSnapshot(
  config: FactoryConfig,
  files: PlanFiles,
  exec: Exec,
): Promise<void> {
  mkdirSync(files.out, { recursive: true });
  const clone = repoDir(config);
  if (existsSync(files.repo)) {
    await exec('git', ['-C', clone, 'worktree', 'remove', '--force', files.repo]);
    rmSync(files.repo, { recursive: true, force: true });
  }
  const added = await exec('git', [
    '-C',
    clone,
    'worktree',
    'add',
    '--detach',
    files.repo,
    'origin/main',
  ]);
  if (added.code !== 0)
    throw new Error(`couldn't make the planning snapshot: ${added.stderr.trim()}`);
}

const CHAT_URL = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/;

export interface SessionInfo {
  readonly sessionId: string;
  readonly status: string;
}

/** The background session for an issue, from `claude agents --json`. */
export async function findSession(
  config: FactoryConfig,
  exec: Exec,
  issue: number,
  env: Record<string, string>,
): Promise<SessionInfo | undefined> {
  const r = await exec(config.agents.claude.bin, ['agents', '--json'], { env });
  if (r.code !== 0) return undefined;
  const sessions = JSON.parse(r.stdout || '[]') as {
    name?: string;
    sessionId: string;
    status: string;
    kind: string;
  }[];
  return sessions.find((s) => s.name === sessionName(issue) && s.kind !== 'interactive');
}

/** Starts (or resumes) the session in the background; returns its chat link when it prints one. */
export async function launchSession(
  config: FactoryConfig,
  exec: Exec,
  files: PlanFiles,
  issue: number,
  message: string,
  env: Record<string, string>,
  resume?: string,
): Promise<{ chatUrl?: string }> {
  const cwd = join(expandHome(config.stateDir), 'plans');
  const args = [
    ...(resume ? ['--resume', resume] : []),
    '--bg',
    '--remote-control',
    sessionName(issue),
    ...planningFlags(files),
    '--',
    message,
  ];
  const r = await exec(config.agents.claude.bin, args, { cwd, env });
  if (r.code !== 0)
    throw new Error(
      `claude --bg failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`,
    );
  const chatUrl = CHAT_URL.exec(r.stdout + r.stderr)?.[0];
  return chatUrl ? { chatUrl } : {};
}

export async function stopSession(
  config: FactoryConfig,
  exec: Exec,
  id: string,
  env: Record<string, string>,
): Promise<void> {
  await exec(config.agents.claude.bin, ['stop', id], { env });
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
