/**
 * One agent session inside a slot's sandbox, with a chat in the Claude app (A1287). `claude -p`
 * never opens Remote Control, so the session is an interactive `claude --remote-control` in a
 * pseudo-terminal (`script`), and this runner makes it look like `claude -p` to Sandcastle:
 *
 * - stdin is the prompt; stdout is stream-json: an `init` line, the session's transcript lines
 *   as Claude Code writes them, a `factory_chat` line with the chat's link, and last a `result`;
 * - the session ends at the Stop or StopFailure hook (a turn ended), and the runner exits 0, or 1
 *   when the turn ended on an error (a usage limit), as `claude -p` does. A turn that ends while
 *   a command it started in the background still runs isn't the end: the command's notification
 *   starts the next turn, and the session ends at the Stop after that (PEN-71's CI repair ended
 *   waiting on its test run, with nothing committed; A1295).
 *
 * Claude signs in with the factory's own claude.ai login, which the host staged for this slot as
 * an access token only (`FACTORY_CLAUDE_LOGIN`, read-only): no refresh token ever enters the
 * sandbox. The config folder is in the sandbox's own home, so nothing here reaches Ryan's.
 *
 * Node runs this file directly (type stripping); it imports nothing but Node's own modules.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The stream line that carries the session's chat link (host.ts reads it). */
export const CHAT_SUBTYPE = 'factory_chat';

/** A terminal's escape sequences (CSI and OSC), stripped from the screen an error quotes. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const TERMINAL_CODES = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*${BEL}`, 'g');

/** How long Claude Code may take to start its session before the runner gives up. */
const START_MS = 120_000;
/** How long a turn that ended on a background command waits for the next (a server never ends). */
export const BACKGROUND_WAIT_MS = Number(process.env['FACTORY_RC_BACKGROUND_MS'] ?? 30 * 60_000);

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null;

function readJson(path: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Claude Code's global config for a fresh session: onboarding, the theme, the Remote Control and
 * bypass-permissions notices and the folder's trust all answered, so nothing waits on a keypress,
 * and the factory login's account, without which Remote Control can't tell its organization.
 */
export function seedConfig(existing: Json | null, account: unknown, cwd: string): Json {
  const projects = isObject(existing?.['projects']) ? existing['projects'] : {};
  const project = isObject(projects[cwd]) ? projects[cwd] : {};
  return {
    ...existing,
    hasCompletedOnboarding: true,
    theme: 'dark',
    remoteDialogSeen: true,
    bypassPermissionsModeAccepted: true,
    ...(isObject(account) ? { oauthAccount: account } : {}),
    projects: {
      ...projects,
      [cwd]: { ...project, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  };
}

/** The chat's link, from Claude Code's debug log: claude.ai serves `cse_<id>` as `session_<id>`. */
export function chatUrlFromDebug(text: string): string | undefined {
  const m = /\[remote-bridge\] Created session cse_([A-Za-z0-9]+)/.exec(text);
  return m ? `https://claude.ai/code/session_${m[1]}` : undefined;
}

/** The text of the transcript's last assistant message that has any (an API error is one). */
export function lastAssistantText(transcript: string): string {
  for (const line of transcript.split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || entry['type'] !== 'assistant') continue;
    const message = entry['message'];
    const content = isObject(message) ? message['content'] : undefined;
    const text = Array.isArray(content)
      ? content
          .filter((b): b is Json => isObject(b) && b['type'] === 'text')
          .map((b) => (typeof b['text'] === 'string' ? b['text'] : ''))
          .join('')
      : typeof content === 'string'
        ? content
        : '';
    if (text.trim()) return text;
  }
  return '';
}

/**
 * The background commands the transcript started (Bash's `run_in_background`) whose
 * notification hasn't come: each launch says "running in background with ID: <id>", and its
 * end is a `<task-notification>` naming the id with a `<status>`.
 */
export function pendingBackground(transcript: string): string[] {
  const started = new Set(
    [...transcript.matchAll(/running in background with ID: ([A-Za-z0-9_-]+)/g)].map((m) => m[1]!),
  );
  const ended = new Set(
    [
      ...transcript.matchAll(
        /<task-id>([A-Za-z0-9_-]+)<\/task-id>((?:(?!<\/task-notification>)[\s\S]){0,4000}?)<status>/g,
      ),
    ].map((m) => m[1]!),
  );
  return [...started].filter((id) => !ended.has(id));
}

/** The `result` line `claude -p` would end with, from the hook that ended the turn. */
export function resultEvent(
  hook: Json,
  transcript: string,
  sessionId: string | undefined,
): { readonly type: 'result'; readonly is_error: boolean; readonly result: string } & Json {
  const failed = hook['hook_event_name'] === 'StopFailure';
  const said =
    typeof hook['last_assistant_message'] === 'string' ? hook['last_assistant_message'] : '';
  const error = typeof hook['error'] === 'string' ? hook['error'] : '';
  const result = said || lastAssistantText(transcript) || error;
  return {
    type: 'result',
    subtype: failed ? 'error_during_execution' : 'success',
    is_error: failed,
    result,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

/** The flags `claude -p` takes that an interactive session doesn't. */
export function interactiveArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--print' || a === '--verbose') continue;
    if (a === '--output-format' || a === '--input-format') {
      i++;
      continue;
    }
    if (a === '-p' && args[i + 1] === '-') {
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** A hook's input, kept for the runner: `<dir>/<event>.json`, written whole or not at all. */
function hook(dir: string): void {
  const input = readFileSync(0, 'utf8');
  const parsed: unknown = JSON.parse(input);
  if (!isObject(parsed) || typeof parsed['hook_event_name'] !== 'string') return;
  const name = parsed['hook_event_name'].replaceAll(/[^A-Za-z]/g, '');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.${process.pid}`);
  writeFileSync(tmp, input);
  renameSync(tmp, join(dir, `${name}.json`));
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function run(name: string, command: readonly string[]): Promise<number> {
  const [bin, ...rest] = command;
  if (!bin) throw new Error('remote-claude: no claude command after --');
  const home = process.env['HOME'] ?? '';
  const login = process.env['FACTORY_CLAUDE_LOGIN'] ?? '';
  if (!home || !login) throw new Error('remote-claude: HOME and FACTORY_CLAUDE_LOGIN must be set');
  const prompt = readFileSync(0, 'utf8');
  const cwd = realpathSync(process.cwd());
  const config = join(home, '.claude');
  const dir = join(home, '.factory-rc');
  mkdirSync(config, { recursive: true, mode: 0o700 });
  // A new session each time: the hooks of the last one in this sandbox mustn't end this one.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const credentials = join(config, '.credentials.json');
  copyFileSync(join(login, 'credentials.json'), credentials);
  chmodSync(credentials, 0o600);
  const globalConfig = join(config, '.claude.json');
  writeFileSync(
    globalConfig,
    JSON.stringify(
      seedConfig(readJson(globalConfig), readJson(join(login, 'account.json')), cwd),
      null,
      2,
    ),
  );

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // The setup token would sign Claude in instead, and it can't open Remote Control.
  delete env['CLAUDE_CODE_OAUTH_TOKEN'];
  delete env['ANTHROPIC_API_KEY'];
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: config,
    FACTORY_RC_DIR: dir,
    FACTORY_RC_SELF: fileURLToPath(import.meta.url),
    TERM: 'xterm-256color',
  });
  const debug = join(dir, 'debug.log');
  const args = [
    ...interactiveArgs(rest),
    '--remote-control',
    name,
    '--debug-file',
    debug,
    '--',
    prompt,
  ];
  // `script` gives Claude its terminal. Its stdin must be a pipe that stays open (a socket, as
  // Sandcastle's is, makes it fail; /dev/null ends the session with ^D).
  const child = spawn(
    '/bin/sh',
    ['-c', 'sleep 2147483647 | exec script -q /dev/null "$@"', 'sh', bin, ...args],
    { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let screen = '';
  const keep = (b: Buffer) => {
    screen = (screen + b.toString('utf8')).slice(-4000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  // Set by the exit handler, so TypeScript can't narrow it away inside the loop.
  const exit = { exited: null as number | null };
  child.on('exit', (code) => {
    exit.exited = code ?? 1;
  });
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
  process.on('SIGTERM', () => {
    stop();
    process.exit(143);
  });

  const out = (line: string) => process.stdout.write(`${line}\n`);
  const started = Date.now();
  let transcript = '';
  let offset = 0;
  let partial = '';
  let session: string | undefined;
  let chat: string | undefined;
  /** The Stop of a turn left waiting on a background command, and until when it waits. */
  let held: { readonly hook: Json; readonly until: number } | undefined;
  const pump = () => {
    if (!transcript) return;
    const size = sizeOf(transcript);
    if (size <= offset) return;
    const buf = readFileSync(transcript).subarray(offset, size);
    offset = size;
    const lines = (partial + buf.toString('utf8')).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) if (line.startsWith('{')) out(line);
  };
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const start = readJson(join(dir, 'SessionStart.json'));
    const path = typeof start?.['transcript_path'] === 'string' ? start['transcript_path'] : '';
    if (path && path !== transcript) {
      transcript = path;
      offset = 0;
      partial = '';
    }
    if (!session && typeof start?.['session_id'] === 'string') {
      session = start['session_id'];
      out(JSON.stringify({ type: 'system', subtype: 'init', session_id: session, cwd }));
    }
    pump();
    if (!chat && existsSync(debug)) {
      chat = chatUrlFromDebug(readFileSync(debug, 'utf8'));
      if (chat) out(JSON.stringify({ type: 'system', subtype: CHAT_SUBTYPE, url: chat }));
    }
    const ended =
      readJson(join(dir, 'StopFailure.json')) ??
      readJson(join(dir, 'Stop.json')) ??
      (held && Date.now() > held.until ? held.hook : null);
    if (ended) {
      // The transcript's last lines can land just after the hook.
      await new Promise((r) => setTimeout(r, 1000));
      pump();
      const text = transcript && existsSync(transcript) ? readFileSync(transcript, 'utf8') : '';
      // A turn that waits on its own background command goes on when the command ends.
      if (
        ended !== held?.hook &&
        ended['hook_event_name'] === 'Stop' &&
        pendingBackground(text).length > 0
      ) {
        rmSync(join(dir, 'Stop.json'), { force: true });
        held = { hook: ended, until: Date.now() + BACKGROUND_WAIT_MS };
        continue;
      }
      const result = resultEvent(ended, text, session);
      out(JSON.stringify(result));
      stop();
      return result.is_error ? 1 : 0;
    }
    const exited = exit.exited;
    if (exited !== null || (!session && Date.now() - started > START_MS)) {
      pump();
      stop();
      const plain = screen.replaceAll(TERMINAL_CODES, '');
      const why =
        exited !== null ? `Claude Code exited (${exited})` : "Claude Code's session didn't start";
      out(
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: `${why} before the turn ended. Its screen ended: ${plain.trim().slice(-1500)}`,
          ...(session ? { session_id: session } : {}),
        }),
      );
      return 1;
    }
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const [mode, ...rest] = argv;
  if (mode === 'hook') {
    hook(process.env['FACTORY_RC_DIR'] ?? join(process.env['HOME'] ?? '', '.factory-rc'));
    return 0;
  }
  const dash = rest.indexOf('--');
  const nameAt = rest.indexOf('--name');
  if (mode !== 'run' || dash < 0 || nameAt < 0 || nameAt > dash)
    throw new Error('usage: remote-claude.ts run --name <name> -- claude <args...>  |  hook');
  return run(rest[nameAt + 1] ?? '[PF] Penmoss factory', rest.slice(dash + 1));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
