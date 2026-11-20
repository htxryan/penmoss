/**
 * AI Descriptions' providers on this Mac (PEN-161, A1656). The page asks for a description through
 * one call, `describe(provider, model, prompt)`, and only the provider the person chose in
 * Settings is ever used: Penmoss never picks one for them, and a missing key never falls back to
 * Claude Code.
 *
 * - **Anthropic (API Key):** the key is typed in Settings → AI Descriptions and kept in
 *   `ai-keys.json`, sealed with `safeStorage` as the GitHub token is (A1012). It never goes back
 *   to a page. Calls go to the Messages API from here.
 * - **Claude Code on This Mac:** the `claude` the person installed, found on their login shell's
 *   PATH, run in print mode with its own sign-in (`claude -p --model <alias> --output-format
 *   json`, no tools, no MCP servers, no session kept), the prompt on stdin. Penmoss never sees its
 *   credentials.
 *
 * The list of providers is data (`PROVIDERS`), so another one is an entry here and a branch in
 * `describe`, with no new page.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANTHROPIC_MODELS,
  CLAUDE_CODE_MODELS,
  type AiProviderId,
} from '@penmoss/core/ai-description';
import type { BoundedExecOptions, BoundedResult } from './bounded-exec';
import type {
  DesktopAiAnswer,
  DesktopAiProvider,
  DesktopAiStatus,
} from '../../web/src/desktop/bridge';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const ANTHROPIC_API = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/** A description is short: the model is never asked for more than this. */
export const MAX_OUTPUT_TOKENS = 300;
export const DESCRIBE_TIMEOUT_MS = 30_000;
/** The longest key taken (Anthropic's are about 108 characters). */
const KEY_MAX = 400;
/** The longest prompt sent (the page cuts notes to about 96,000 characters first). */
const PROMPT_MAX = 200_000;

export const PROVIDERS: readonly DesktopAiProvider[] = [
  { id: 'anthropic', label: 'Anthropic (API Key)', signIn: 'key', models: ANTHROPIC_MODELS },
  {
    id: 'claude-code',
    label: 'Claude Code on This Mac',
    signIn: 'cli',
    models: CLAUDE_CODE_MODELS,
  },
];

export interface AiProvidersOptions {
  readonly dir: string;
  /** Encrypts with the Keychain's key; null when it cannot (then no key is kept). */
  readonly seal: (plain: string) => Promise<string | null>;
  readonly unseal: (sealed: string) => Promise<string | null>;
  readonly fetch: Fetch;
  /** Runs a program with a time limit, never through a shell (`boundedExec`). */
  readonly exec: (options: BoundedExecOptions) => Promise<BoundedResult>;
  /** The login shell's PATH, where `claude` is looked for; null when it could not be asked. */
  readonly loginPath: () => Promise<string | null>;
  /** Where else `claude` may be when the login shell's PATH lacks it (the tests pass none). */
  readonly installDirs?: readonly string[];
  /** A fake Anthropic for the tests (unpackaged builds only). */
  readonly api?: string | null;
  readonly log?: (message: string) => void;
  readonly onChange?: () => void;
}

interface StoredKeys {
  readonly anthropic?: { readonly sealed: string; readonly problem: string | null };
  /** The first run asked "Describe Notes for Agents?" on this Mac: it asks only once. */
  readonly asked?: boolean;
}

/** Plain words for what went wrong; never the key, never the note. */
const WORDS = {
  noProvider: 'Choose an AI provider in Settings → AI Descriptions.',
  noKey: 'Add your Anthropic API key in Settings → AI Descriptions.',
  refused: 'Anthropic refused the API key. Check it in Settings → AI Descriptions.',
  offline: 'Couldn’t reach the AI provider. Check your connection.',
  rateLimited: 'The AI provider is busy or over its limit. Try again later.',
  timeout: 'The AI provider took too long to answer.',
  failed: 'The AI provider couldn’t write a description.',
  ccMissing: 'Claude Code isn’t installed on this Mac.',
  ccSignedOut: 'Claude Code isn’t signed in. Run `claude` in Terminal to sign in.',
  keychain: 'This Mac can’t keep the key: the Keychain isn’t available.',
} as const;

export class AiProviders {
  private keys: StoredKeys | null = null;
  private claudePath: string | null | undefined;
  private claudeState: DesktopAiStatus['claudeCode'] = { state: 'unknown', version: null };

  constructor(private readonly options: AiProvidersOptions) {}

  private get file(): string {
    return join(this.options.dir, 'ai-keys.json');
  }

  private get api(): string {
    return this.options.api ?? ANTHROPIC_API;
  }

  private async load(): Promise<StoredKeys> {
    if (this.keys) return this.keys;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as StoredKeys;
      const a = parsed.anthropic;
      this.keys =
        a && typeof a.sealed === 'string'
          ? {
              anthropic: {
                sealed: a.sealed,
                problem: typeof a.problem === 'string' ? a.problem : null,
              },
            }
          : {};
      if (parsed.asked === true) this.keys = { ...this.keys, asked: true };
    } catch {
      this.keys = {};
    }
    return this.keys;
  }

  private async keep(keys: StoredKeys): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(keys), { mode: 0o600 });
    await rename(temp, this.file);
    this.keys = keys;
    this.options.onChange?.();
  }

  private async anthropicKey(): Promise<string | null> {
    const stored = (await this.load()).anthropic;
    if (!stored) return null;
    return (await this.options.unseal(stored.sealed).catch(() => null)) || null;
  }

  private async keychain(): Promise<boolean> {
    return (await this.options.seal('check').catch(() => null)) !== null;
  }

  async status(): Promise<DesktopAiStatus> {
    const stored = (await this.load()).anthropic;
    return {
      providers: PROVIDERS,
      anthropic: {
        saved: stored !== undefined,
        problem: stored?.problem ?? null,
        keychain: await this.keychain(),
      },
      claudeCode: await this.claudeCodeStatus(),
      asked: (await this.load()).asked === true,
    };
  }

  /** Checks the key with Anthropic, then keeps it sealed. A refused key is not kept. */
  async saveKey(
    raw: string,
  ): Promise<{ ok: true; status: DesktopAiStatus } | { ok: false; message: string }> {
    const key = raw.trim();
    if (key === '' || key.length > KEY_MAX || /\s/.test(key)) {
      return { ok: false, message: 'That doesn’t look like an API key.' };
    }
    const sealed = await this.options.seal(key).catch(() => null);
    if (sealed === null) return { ok: false, message: WORDS.keychain };
    const check = await this.checkKey(key);
    if (check === 'refused') return { ok: false, message: WORDS.refused };
    await this.keep({
      ...(await this.load()),
      anthropic: { sealed, problem: check === 'ok' ? null : WORDS[check] },
    });
    return { ok: true, status: await this.status() };
  }

  /** The first run asked its question on this Mac; it is not asked again. */
  async markAsked(): Promise<DesktopAiStatus> {
    const keys = await this.load();
    if (keys.asked !== true) await this.keep({ ...keys, asked: true });
    return this.status();
  }

  async removeKey(): Promise<{ ok: true; status: DesktopAiStatus }> {
    const rest = { ...(await this.load()) };
    delete rest.anthropic;
    await this.keep(rest);
    return { ok: true, status: await this.status() };
  }

  /** Whether `provider` works now, in plain words. */
  async test(provider: string): Promise<{ ok: boolean; message: string }> {
    if (provider === 'anthropic') {
      const key = await this.anthropicKey();
      if (!key) return { ok: false, message: WORDS.noKey };
      const check = await this.checkKey(key);
      await this.markProblem(check === 'ok' ? null : WORDS[check]);
      return check === 'ok'
        ? { ok: true, message: 'Anthropic accepted the API key.' }
        : { ok: false, message: WORDS[check] };
    }
    if (provider === 'claude-code') {
      this.claudePath = undefined;
      const status = await this.claudeCodeStatus(true);
      if (status.state === 'missing') return { ok: false, message: WORDS.ccMissing };
      if (status.state === 'signed-out') return { ok: false, message: WORDS.ccSignedOut };
      if (status.state === 'unknown') return { ok: false, message: WORDS.failed };
      return {
        ok: true,
        message: `Claude Code ${status.version ?? ''} is signed in.`.replace('  ', ' '),
      };
    }
    return { ok: false, message: WORDS.noProvider };
  }

  private async markProblem(problem: string | null): Promise<void> {
    const keys = await this.load();
    if (!keys.anthropic || keys.anthropic.problem === problem) return;
    await this.keep({ ...keys, anthropic: { ...keys.anthropic, problem } });
  }

  /** `GET /v1/models`: costs nothing, and says whether the key is accepted. */
  private async checkKey(key: string): Promise<'ok' | 'refused' | 'offline' | 'rateLimited'> {
    try {
      const response = await this.options.fetch(`${this.api}/v1/models?limit=1`, {
        headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401 || response.status === 403) return 'refused';
      if (response.status === 429) return 'rateLimited';
      return response.ok ? 'ok' : 'offline';
    } catch {
      return 'offline';
    }
  }

  /** Sends the prompt to the chosen provider. Nothing is sent for `none` or an unknown id. */
  async describe(provider: string, model: string, prompt: string): Promise<DesktopAiAnswer> {
    const id = provider as AiProviderId;
    if (prompt.trim() === '') return fail('failed', WORDS.failed);
    const text = prompt.length > PROMPT_MAX ? prompt.slice(0, PROMPT_MAX) : prompt;
    if (id === 'anthropic') return this.describeAnthropic(model, text);
    if (id === 'claude-code') return this.describeClaudeCode(model, text);
    return fail('no-provider', WORDS.noProvider);
  }

  private async describeAnthropic(model: string, prompt: string): Promise<DesktopAiAnswer> {
    const known = ANTHROPIC_MODELS.find((each) => each.id === model)?.id ?? ANTHROPIC_MODELS[0]!.id;
    const key = await this.anthropicKey();
    if (!key) return fail('no-key', WORDS.noKey);
    if ((await this.load()).anthropic?.problem === WORDS.refused) {
      // A refused key stops later calls until it changes (AD10).
      return fail('refused', WORDS.refused);
    }
    let response: Response;
    try {
      response = await this.options.fetch(`${this.api}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: known,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
      });
    } catch (error) {
      return (error as Error).name === 'TimeoutError'
        ? fail('timeout', WORDS.timeout)
        : fail('offline', WORDS.offline);
    }
    if (response.status === 401 || response.status === 403) {
      await this.markProblem(WORDS.refused);
      return fail('refused', WORDS.refused);
    }
    if (response.status === 429 || response.status === 529) {
      return fail('rate-limited', WORDS.rateLimited);
    }
    if (!response.ok) {
      this.options.log?.(`AI Descriptions: Anthropic answered ${response.status}`);
      return fail('failed', WORDS.failed);
    }
    const body = (await response.json().catch(() => null)) as {
      content?: { type?: string; text?: string }[];
    } | null;
    const text = (body?.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
      .trim();
    return text ? { ok: true, text } : fail('failed', WORDS.failed);
  }

  /** Where `claude` is: the login shell's PATH, then the usual install places. */
  private async findClaude(): Promise<string | null> {
    if (this.claudePath !== undefined) return this.claudePath;
    const home = process.env['HOME'] ?? '';
    const path = (await this.options.loginPath().catch(() => null)) ?? '';
    const dirs = [
      ...path.split(':').filter(Boolean),
      ...(this.options.installDirs ?? [
        join(home, '.local/bin'),
        join(home, '.claude/local'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ]),
    ];
    for (const dir of dirs) {
      const candidate = join(dir, 'claude');
      const ran = await this.options.exec({
        command: candidate,
        args: ['--version'],
        timeoutMs: 8000,
        env: this.env(path),
      });
      if (ran.kind === 'exit' && ran.code === 0) {
        this.claudePath = candidate;
        this.claudeState = { ...this.claudeState, version: versionOf(ran.stdout) };
        return candidate;
      }
    }
    this.claudePath = null;
    return null;
  }

  private env(path: string): NodeJS.ProcessEnv {
    // Claude Code with its own sign-in; never an API key the app was started with.
    const rest = { ...process.env };
    delete rest['ANTHROPIC_API_KEY'];
    return {
      ...rest,
      PATH: path || rest['PATH'] || '/usr/bin:/bin',
      CLAUDE_CODE_ENTRYPOINT: 'penmoss',
    };
  }

  /** Found and signed in, found but signed out, or not installed. Cached until `fresh`. */
  async claudeCodeStatus(fresh = false): Promise<DesktopAiStatus['claudeCode']> {
    if (!fresh && this.claudeState.state !== 'unknown') return this.claudeState;
    const claude = await this.findClaude();
    if (!claude) {
      this.claudeState = { state: 'missing', version: null };
      return this.claudeState;
    }
    const ran = await this.options.exec({
      command: claude,
      args: ['auth', 'status', '--json'],
      timeoutMs: 10_000,
      env: this.env((await this.options.loginPath().catch(() => null)) ?? ''),
    });
    let signedIn: boolean | null = null;
    if (ran.kind === 'exit') {
      try {
        signedIn = (JSON.parse(ran.stdout) as { loggedIn?: unknown }).loggedIn === true;
      } catch {
        signedIn = ran.code === 0 ? null : false;
      }
    }
    this.claudeState = {
      state: signedIn === null ? 'ready' : signedIn ? 'ready' : 'signed-out',
      version: this.claudeState.version,
    };
    return this.claudeState;
  }

  private async describeClaudeCode(model: string, prompt: string): Promise<DesktopAiAnswer> {
    const alias =
      CLAUDE_CODE_MODELS.find((each) => each.id === model)?.id ?? CLAUDE_CODE_MODELS[0]!.id;
    const claude = await this.findClaude();
    if (!claude) return fail('no-provider', WORDS.ccMissing);
    const ran = await this.options.exec({
      command: claude,
      args: [
        '-p',
        '--model',
        alias,
        '--output-format',
        'json',
        '--tools',
        '',
        '--strict-mcp-config',
        '--no-session-persistence',
        '--disable-slash-commands',
      ],
      input: prompt,
      timeoutMs: DESCRIBE_TIMEOUT_MS * 2,
      // In a folder of no project, so no project's CLAUDE.md or settings come into the prompt.
      cwd: tmpdir(),
      env: this.env((await this.options.loginPath().catch(() => null)) ?? ''),
    });
    if (ran.kind === 'timeout') return fail('timeout', WORDS.timeout);
    if (ran.kind === 'error') return fail('no-provider', WORDS.ccMissing);
    const parsed = parseJson(ran.stdout);
    if (ran.code !== 0 || !parsed || parsed.is_error === true) {
      const said = `${ran.stdout}\n${ran.stderr}`.toLowerCase();
      if (said.includes('login') || said.includes('log in') || said.includes('not authenticated')) {
        this.claudeState = { ...this.claudeState, state: 'signed-out' };
        return fail('refused', WORDS.ccSignedOut);
      }
      if (said.includes('rate') || said.includes('usage limit')) {
        return fail('rate-limited', WORDS.rateLimited);
      }
      this.options.log?.(`AI Descriptions: Claude Code exited ${ran.code ?? 'by a signal'}`);
      return fail('failed', WORDS.failed);
    }
    const text = typeof parsed.result === 'string' ? parsed.result.trim() : '';
    return text ? { ok: true, text } : fail('failed', WORDS.failed);
  }
}

function fail(code: string, message: string): DesktopAiAnswer {
  return { ok: false, code, message };
}

interface PrintResult {
  readonly result?: unknown;
  readonly is_error?: unknown;
}

function parseJson(stdout: string): PrintResult | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

function versionOf(stdout: string): string | null {
  return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null;
}
