/**
 * AI Descriptions' providers on the Mac (PEN-161): the Anthropic key kept sealed and checked when
 * saved, never kept when refused, never sent anywhere but Anthropic; Claude Code run in print
 * mode only when chosen; `none` sends nothing.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiProviders } from '../../src/ai-provider';
import { boundedExec } from '../../src/bounded-exec';

const KEY = 'sk-ant-test-key';
let dir: string;
let bin: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'penmoss-ai-'));
  bin = await mkdtemp(join(tmpdir(), 'penmoss-ai-bin-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
});

const seal = (plain: string) => Promise.resolve(`sealed:${Buffer.from(plain).toString('base64')}`);
const unseal = (sealed: string) =>
  Promise.resolve(Buffer.from(sealed.replace(/^sealed:/, ''), 'base64').toString());

interface Seen {
  url: string;
  key: string | null;
  body: unknown;
}

/** A fake Anthropic: accepts KEY, answers `text` to /v1/messages. */
function fakeAnthropic(options: { status?: number; text?: string } = {}) {
  const seen: Seen[] = [];
  const answer = (input: string | URL | Request, init?: RequestInit): Response => {
    const url = input instanceof Request ? input.url : input.toString();
    const headers = new Headers(init?.headers);
    const key = headers.get('x-api-key');
    seen.push({
      url,
      key,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });
    if (key !== KEY) return new Response('{}', { status: 401 });
    if (options.status) return new Response('{}', { status: options.status });
    if (url.includes('/v1/models')) return new Response('{"data":[]}', { status: 200 });
    return new Response(
      JSON.stringify({ content: [{ type: 'text', text: options.text ?? 'A plan for the week.' }] }),
      { status: 200 },
    );
  };
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    Promise.resolve(answer(input, init));
  return { fetch, seen };
}

function providers(fetch: ReturnType<typeof fakeAnthropic>['fetch'], path = bin) {
  return new AiProviders({
    dir,
    seal,
    unseal,
    fetch,
    exec: boundedExec,
    loginPath: () => Promise.resolve(`${path}:/usr/bin:/bin`),
    installDirs: [],
    api: 'http://127.0.0.1:1',
  });
}

/** A fake `claude` on PATH: prints its version, its auth status, and a print-mode answer. */
async function fakeClaude(options: { loggedIn?: boolean; answer?: string } = {}) {
  const answer = JSON.stringify({
    type: 'result',
    is_error: false,
    result: options.answer ?? 'Notes on sync.',
  });
  const script = `#!/bin/sh
case "$1" in
  --version) echo "2.1.328 (Claude Code)";;
  auth) echo '{"loggedIn": ${options.loggedIn === false ? 'false' : 'true'}}';;
  -p) cat > "${bin}/prompt.txt"; echo "$@" > "${bin}/args.txt"; pwd > "${bin}/cwd.txt"; echo '${answer}';;
esac
`;
  await writeFile(join(bin, 'claude'), script);
  await chmod(join(bin, 'claude'), 0o755);
}

describe('the Anthropic key', () => {
  it('is checked, kept sealed and never written in the clear', async () => {
    const fake = fakeAnthropic();
    const ai = providers(fake.fetch);
    const saved = await ai.saveKey(` ${KEY} `);
    expect(saved.ok).toBe(true);
    const file = await readFile(join(dir, 'ai-keys.json'), 'utf8');
    expect(file).not.toContain(KEY);
    expect((await ai.status()).anthropic).toMatchObject({ saved: true, problem: null });
    expect(fake.seen[0]!.url).toContain('/v1/models');
  });

  it('is not kept when Anthropic refuses it', async () => {
    const ai = providers(fakeAnthropic().fetch);
    const saved = await ai.saveKey('sk-wrong');
    expect(saved).toEqual({ ok: false, message: expect.stringContaining('refused') as string });
    expect((await ai.status()).anthropic.saved).toBe(false);
  });

  it('describes with the chosen model, a small limit, and the prompt', async () => {
    const fake = fakeAnthropic({ text: '  Weekly plans.  ' });
    const ai = providers(fake.fetch);
    await ai.saveKey(KEY);
    const answer = await ai.describe('anthropic', 'claude-haiku-5-5', 'Describe this.');
    expect(answer).toEqual({ ok: true, text: 'Weekly plans.' });
    const call = fake.seen.at(-1)!;
    expect(call.url).toContain('/v1/messages');
    expect(call.body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 300,
      messages: [{ role: 'user', content: 'Describe this.' }],
    });
  });

  it('remembers that the first run asked, beside the key', async () => {
    const fake = fakeAnthropic({ status: 200 });
    expect((await providers(fake.fetch).status()).asked).toBe(false);
    expect((await providers(fake.fetch).markAsked()).asked).toBe(true);
    // A new start reads it back, and a key saved later keeps it.
    const again = providers(fake.fetch);
    expect((await again.status()).asked).toBe(true);
    await again.saveKey(KEY);
    expect((await providers(fake.fetch).status()).asked).toBe(true);
  });

  it('stops after a refused key until it changes', async () => {
    const fake = fakeAnthropic({ status: 401 });
    const ai = providers(fake.fetch);
    await writeFile(
      join(dir, 'ai-keys.json'),
      JSON.stringify({ anthropic: { sealed: await seal(KEY), problem: null } }),
    );
    expect((await ai.describe('anthropic', 'claude-haiku-5-5', 'x')).ok).toBe(false);
    const calls = fake.seen.length;
    const again = await ai.describe('anthropic', 'claude-haiku-5-5', 'x');
    expect(again).toMatchObject({ ok: false, code: 'refused' });
    expect(fake.seen.length).toBe(calls);
  });

  it('says rate-limited and no key in plain words', async () => {
    const fake = fakeAnthropic({ status: 429 });
    expect(await providers(fake.fetch).describe('anthropic', 'x', 'p')).toMatchObject({
      code: 'no-key',
    });
    await writeFile(
      join(dir, 'ai-keys.json'),
      JSON.stringify({ anthropic: { sealed: await seal(KEY), problem: null } }),
    );
    expect(await providers(fake.fetch).describe('anthropic', 'x', 'p')).toMatchObject({
      code: 'rate-limited',
    });
  });
});

describe('the provider choice', () => {
  it('sends nothing for none, and never falls back to Claude Code', async () => {
    await fakeClaude();
    const fake = fakeAnthropic();
    const ai = providers(fake.fetch);
    expect(await ai.describe('none', 'haiku', 'p')).toMatchObject({
      ok: false,
      code: 'no-provider',
    });
    expect(await ai.describe('anthropic', 'haiku', 'p')).toMatchObject({
      ok: false,
      code: 'no-key',
    });
    expect(fake.seen).toHaveLength(0);
    await expect(readFile(join(bin, 'prompt.txt'), 'utf8')).rejects.toThrow();
  });
});

describe('Claude Code', () => {
  it('runs claude -p with no tools, the prompt on stdin, outside any project', async () => {
    await fakeClaude({ answer: 'Notes on the sync design.' });
    const ai = providers(fakeAnthropic().fetch);
    const answer = await ai.describe('claude-code', 'haiku', 'Describe me.');
    expect(answer).toEqual({ ok: true, text: 'Notes on the sync design.' });
    expect(await readFile(join(bin, 'prompt.txt'), 'utf8')).toBe('Describe me.');
    const args = await readFile(join(bin, 'args.txt'), 'utf8');
    expect(args).toContain('-p --model haiku --output-format json --tools');
    expect(args).toContain('--strict-mcp-config');
    expect((await readFile(join(bin, 'cwd.txt'), 'utf8')).trim()).not.toContain('penmoss');
  });

  it('reports found and signed in, signed out, or missing', async () => {
    const ai = providers(fakeAnthropic().fetch);
    expect((await ai.claudeCodeStatus(true)).state).toBe('missing');
    await fakeClaude({ loggedIn: false });
    const signedOut = providers(fakeAnthropic().fetch);
    expect(await signedOut.claudeCodeStatus(true)).toEqual({
      state: 'signed-out',
      version: '2.1.328',
    });
    expect((await signedOut.test('claude-code')).ok).toBe(false);
    await fakeClaude();
    const ready = providers(fakeAnthropic().fetch);
    expect((await ready.test('claude-code')).ok).toBe(true);
  });
});
