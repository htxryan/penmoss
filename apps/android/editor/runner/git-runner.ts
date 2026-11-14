/**
 * The git engine page and the Node CLI for the JVM tests (T50 G7, A878): `engine-bridge`'s
 * cross-engine tests run this with Node, so Kotlin's `GitNotebooks`, `JGitTransport` and
 * `LocalGitApi` drive the very page code the APK ships (`src/git/*`) over the same frames, and the
 * CLI's own commands (the Mac's and the CLI's engine over system git) sync the same repository.
 *
 * - `page <dir>`: one notebook's engine page, its store in files under `<dir>`;
 * - `guard`: the commit check page;
 * - `cli <home> <args…>`: `penmoss <args…>` with `PENMOSS_HOME`-style state in `<home>`, its
 *   secrets in a file there (never a keychain);
 * - `describe <remote> <dir> [<tag> <text>]…`: the Mac app's writer on a clone in `<dir>` describes
 *   tags in the notebook's WorkspaceDoc (PEN-68) and pushes; with no pair, it prints what an agent's
 *   `describe_tags` gives, as JSON.
 *
 * Frames go over stdio, each as a big-endian u32 length and the frame's bytes. Never shipped.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineKv } from '../../../web/src/sources/engine-store';
import { serveEngine, serveGuard } from '../src/git/page';
import type { FramePort } from '../src/git/channel';
import { run } from '../../../../packages/cli/src/main';
import { nodeNotebooks } from '../../../../packages/cli/src/node-notebooks';
import type { Io, TokenLocation, TokenStore } from '../../../../packages/cli/src/io';
import { parseMarkdown } from '@penmoss/core';
import { initNote, setTitle } from '@penmoss/sync-client/note';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { docToDelta } from '@y/prosemirror';
import { toBase64 } from 'lib0/buffer';
import * as Y from '@y/y';
import { GitNotebookEngine, MemorySecrets, MemoryStorage, NotebookOps } from '@penmoss/git-notebook';
import { LocalNotebook } from '@penmoss/git-notebook/local';
import { NodeGitTransport } from '@penmoss/git-notebook/node';
import { setTagDescription } from '@penmoss/sync-client/workspace';

function stdioPort(): FramePort {
  let buffered: Buffer = Buffer.alloc(0);
  let listener: ((frame: Uint8Array) => void) | null = null;
  const queue: Uint8Array[] = [];
  process.stdin.on('data', (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (buffered.length < 4 + length) break;
      const frame = new Uint8Array(buffered.subarray(4, 4 + length));
      buffered = buffered.subarray(4 + length);
      if (listener) listener(frame);
      else queue.push(frame);
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return {
    send: (frame) => {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(frame.byteLength, 0);
      process.stdout.write(
        Buffer.concat([head, Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)]),
      );
    },
    listen: (next) => {
      listener = next;
      for (const frame of queue.splice(0)) next(frame);
    },
  };
}

/** An `EngineKv` in files: one per key, bytes as `.bin`, anything else as `.json`. */
async function fileKv(dir: string): Promise<EngineKv> {
  await mkdir(dir, { recursive: true });
  const name = (key: string) => encodeURIComponent(key).replace(/\./g, '%2E');
  const read = async (file: string): Promise<unknown> => {
    const path = join(dir, file);
    if (file.endsWith('.bin')) return new Uint8Array(await readFile(path));
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  };
  const remove = async (key: string) => {
    await rm(join(dir, `${name(key)}.bin`), { force: true });
    await rm(join(dir, `${name(key)}.json`), { force: true });
  };
  return {
    get: async (key) => {
      for (const file of [`${name(key)}.bin`, `${name(key)}.json`]) {
        if (await stat(join(dir, file)).catch(() => null)) return read(file);
      }
      return undefined;
    },
    entries: async (prefix) => {
      const out: Array<[string, unknown]> = [];
      for (const file of (await readdir(dir)).sort()) {
        if (file.endsWith('.tmp')) continue;
        const key = decodeURIComponent(file.replace(/\.(bin|json)$/, ''));
        if (key.startsWith(prefix)) out.push([key, await read(file)]);
      }
      return out.sort(([a], [b]) => (a < b ? -1 : 1));
    },
    write: async (puts, deletes = []) => {
      for (const [key, value] of puts) {
        await remove(key);
        const file = `${name(key)}.${value instanceof Uint8Array ? 'bin' : 'json'}`;
        const temporary = join(dir, `${file}.tmp`);
        await writeFile(temporary, value instanceof Uint8Array ? value : JSON.stringify(value));
        await rename(temporary, join(dir, file));
      }
      for (const key of deletes) await remove(key);
    },
  };
}

/** A token store in a file (the tests' own; never a keychain on the CI Macs). */
function fileTokenStore(path: string): TokenStore {
  const load = async (): Promise<Record<string, string>> =>
    JSON.parse(await readFile(path, 'utf8').catch(() => '{}')) as Record<string, string>;
  const save = async (tokens: Record<string, string>) =>
    writeFile(path, JSON.stringify(tokens), { mode: 0o600 });
  return {
    describe: () => ({ keychain: 'test file', file: path }),
    get: async (key) => {
      const token = (await load())[key];
      return token ? { token, location: 'file' as const } : null;
    },
    set: async (key, token) => {
      await save({ ...(await load()), [key]: token });
      return { location: 'file' as const };
    },
    delete: async (key) => {
      const tokens = await load();
      const had: TokenLocation[] = key in tokens ? ['file'] : [];
      delete tokens[key];
      await save(tokens);
      return had;
    },
  };
}

async function cli(home: string, argv: string[]): Promise<number> {
  const gitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  await mkdir(home, { recursive: true });
  const notebooks = nodeNotebooks({
    terminal: () => true,
    home,
    env: {},
    platform: process.platform,
    secrets: fileTokenStore(join(home, 'runner-secrets.json')),
    gitEnv,
    pushDelayMs: 50,
    pullEveryMs: 60_000,
    lockWaitMs: 5_000,
  });
  const io: Io = {
    env: {},
    stdin: { isTTY: false, read: () => Promise.resolve('') },
    stdout: { isTTY: false, write: (text) => void process.stdout.write(text) },
    stderr: { write: (text) => void process.stderr.write(text) },
    openUrl: () => Promise.resolve(false),
    readFile: (path) => Promise.resolve(new Uint8Array(readFileSync(path))),
    fileSize: (path) => Promise.resolve(statSync(path).size),
    notebooks,
  };
  return run(argv, io);
}

/**
 * A note as the phone's editor makes one (its own doc and client id), as the base64 update Room
 * keeps: `note <id> <title> <markdown>`, or `retitle <id> <title> <update>` for an edit on top.
 */
function editorNote(id: string, title: string, markdown: string): string {
  const doc = new Y.Doc();
  doc.transact(() => {
    initNote(doc, { id, created: new Date().toISOString(), kind: 'note' }, title);
    if (markdown) doc.get(NOTE_ROOT).applyDelta(docToDelta(parseMarkdown(markdown).doc));
  });
  return toBase64(Y.encodeStateAsUpdate(doc));
}

/**
 * The Mac app's writer (or, with no `pairs`, an agent reading) on a fresh clone of `remote` in
 * `dir` (PEN-68): sets each tag's description and pushes, or prints `describe_tags`' answer.
 */
async function describe(remote: string, dir: string, pairs: string[]): Promise<void> {
  const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const transport = new NodeGitTransport({
    gitDir: join(dir, 'repo.git'),
    remote,
    branch: 'main',
    root: '',
    author: { name: 'Ryan on the Mac', email: 'ryan@example.invalid' },
    env,
    sign: false,
  });
  await transport.init();
  const reading = pairs.length === 0;
  const engine = await GitNotebookEngine.open({
    transport,
    storage: new MemoryStorage(),
    secrets: new MemorySecrets(),
    writer: reading ? { kind: 'agent', label: 'Reader' } : { kind: 'device', label: 'Mac' },
  });
  await engine.sync();
  const ops = new NotebookOps(engine);
  if (reading) {
    process.stdout.write(`${JSON.stringify(new LocalNotebook(ops).describeTags())}\n`);
    return;
  }
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    setTagDescription(ops.workspace, pairs[i]!, pairs[i + 1]!);
  }
  await engine.save();
  const report = await engine.sync();
  if (!report.commit) throw new Error('The descriptions made no commit.');
}

const [role, ...rest] = process.argv.slice(2);
if (role === 'page') {
  const dir = rest[0]!;
  const channel = serveEngine(stdioPort(), {
    open: (notebookId) => fileKv(join(dir, notebookId)),
    forget: (notebookId) => rm(join(dir, notebookId), { recursive: true, force: true }),
  });
  channel.emit('ready');
} else if (role === 'guard') {
  serveGuard(stdioPort()).emit('ready');
} else if (role === 'cli') {
  const [home, ...argv] = rest;
  cli(home!, argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exit(1);
    },
  );
} else if (role === 'note') {
  process.stdout.write(`${editorNote(rest[0]!, rest[1] ?? '', rest[2] ?? '')}\n`);
} else if (role === 'retitle') {
  // An edit made on the phone's copy: the update the editor would store as pending.
  const doc = new Y.Doc();
  for (const update of rest.slice(2)) Y.applyUpdate(doc, Buffer.from(update, 'base64'));
  const before = Y.encodeStateVector(doc);
  setTitle(doc, rest[1] ?? '');
  process.stdout.write(`${toBase64(Y.encodeStateAsUpdate(doc, before))}\n`);
} else if (role === 'describe') {
  describe(rest[0]!, rest[1]!, rest.slice(2)).then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exit(1);
    },
  );
} else {
  process.stderr.write(
    'usage: git-runner page <dir> | guard | cli <home> <args…> | note <id> <title> <markdown>\n',
  );
  process.exit(2);
}
