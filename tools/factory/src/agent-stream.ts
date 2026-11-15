/**
 * An agent session's stream and log as the host reads them (F9: out of host.ts): the chat link,
 * the last result and error events, a missing agent, and why a session ended.
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { CHAT_SUBTYPE } from '../sandbox/remote-claude.ts';

/** The agent's raw output stream in the run folder, beside Sandcastle's `agent.log`. */
export const AGENT_STREAM = 'agent.stream.jsonl';

/** The current session's chat link, in the run folder while the session runs (the UI reads it). */
export const CHAT_URL = 'chat-url';

/** The chat link the in-sandbox runner reports (sandbox/remote-claude.ts), from a stream line. */
export function chatUrlOf(line: string): string | undefined {
  if (!line.includes(CHAT_SUBTYPE)) return undefined;
  try {
    const event = JSON.parse(line) as { type?: unknown; subtype?: unknown; url?: unknown };
    if (event.type !== 'system' || event.subtype !== CHAT_SUBTYPE) return undefined;
    return typeof event.url === 'string' &&
      /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/.test(event.url)
      ? event.url
      : undefined;
  } catch {
    return undefined;
  }
}

/** The last `result` event a session added to the agent's stream after `from`, if any. */
export function lastResultEvent(
  streamFile: string,
  from: number,
): { readonly is_error?: unknown; readonly result?: unknown } | null {
  let text: string;
  try {
    text = readFileSync(streamFile).subarray(from).toString('utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n').reverse()) {
    if (!line.includes('"result"')) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; is_error?: unknown; result?: unknown };
      if (event.type === 'result') return event;
    } catch {
      // A partial line: the stream is written as the agent goes.
    }
  }
  return null;
}

/**
 * The last `error` event in an OpenCode stream from `from`, as JSON, or null. OpenCode ends a
 * session refused by its provider with one, and only it carries the wait: OpenCode Go's limit
 * says `"retryAfterMs":11504000`, while agent.log says only "usage limit reached" (PEN-117).
 */
export function lastErrorEvent(streamFile: string, from: number): string | null {
  let text: string;
  try {
    text = readFileSync(streamFile).subarray(from).toString('utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n').reverse()) {
    if (!line.includes('"error"')) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown; error?: unknown };
      if (event.type === 'error' && event.error) return JSON.stringify(event.error);
    } catch {
      // A partial line: the stream is written as the agent goes.
    }
  }
  return null;
}

/**
 * Copies the plain files directly in `from` (validation's review.json, captures.json and each
 * criterion's screenshot and mockup) into `to`, before the sandbox's worktree is gone (A1256).
 * Never through a symlink or into a subfolder: the agent wrote `from`. Returns the names copied.
 */
export function keepFiles(from: string, to: string): string[] {
  if (!existsSync(from) || !lstatSync(from).isDirectory()) return [];
  const names = readdirSync(from).filter((n) => lstatSync(join(from, n)).isFile());
  if (names.length === 0) return [];
  mkdirSync(to, { recursive: true });
  for (const n of names) copyFileSync(join(from, n), join(to, n));
  return names;
}

/**
 * The command a shell couldn't find, from an agent's failure: `sh`'s "claude: command not found"
 * or exit 127, zsh's "command not found: claude". Undefined for any other failure.
 */
export function agentMissing(message: string): string | undefined {
  const named =
    /command not found: (\S+)/.exec(message)?.[1] ??
    /([^\s:/]+): command not found/.exec(message)?.[1];
  if (named) return named;
  if (!/exited with code 127\b/.test(message)) return undefined;
  // dash: "sh: 1: claude: not found", only with the shell's own exit code.
  return /([^\s:/]+): not found/.exec(message)?.[1] ?? "the agent's command";
}

/**
 * The agent CLI isn't where the factory looks: an installation problem, not the card's. The run
 * says so plainly (start.ts), with the PATH the sandbox had (the LaunchAgent's, A1226).
 */
export class AgentNotInstalled extends Error {
  readonly command: string;

  constructor(command: string, path: string) {
    super(
      `the factory can't find \`${command}\` on its PATH (${path}). That is the factory's installation, not this card: install it on that PATH, or set its full path as the agent's \`bin\` in tools/factory/factory.config.json, then task factory:install (task factory:doctor checks it)`,
    );
    this.name = 'AgentNotInstalled';
    this.command = command;
  }
}

/**
 * Sandcastle ends its log with "reached 1 iteration(s) without completion signal" after every
 * run: the factory never gives the agent Sandcastle's completion signal (it reads
 * `.factory/result.json` instead, and one iteration is all it asks for), so that line is
 * expected. The log says so beneath it, so it doesn't read as a failure.
 */
export function explainCompletion(logFile: string): void {
  let text: string;
  try {
    text = readFileSync(logFile, 'utf8');
  } catch {
    return;
  }
  if (!/without completion signal\.?\s*$/.test(text)) return;
  appendFileSync(
    logFile,
    "(The factory: that is expected. It doesn't use Sandcastle's completion signal; the agent's .factory/result.json says how the round ended.)\n",
  );
}
