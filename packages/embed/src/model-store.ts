/**
 * The model on disk (A1151): `~/.penmoss/models/<name>@<revision>/`, fetched once from Hugging
 * Face at the pinned commit. Files download into a partial folder beside it, each resumed with a
 * Range request after an interruption and checked against the manifest's SHA-256, and the folder
 * is renamed into place only when every file is right. One process downloads at a time (a lock
 * file with a heartbeat); another waits for it. Opening the model checks each hash again.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { manifestBytes, type ModelFile, type ModelManifest } from './manifest';

/** Where Penmoss keeps notebooks, models and vectors (the CLI's PENMOSS_HOME). */
export function penmossHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['PENMOSS_HOME'] || join(homedir(), '.penmoss');
}

export type ModelErrorCode = 'absent' | 'corrupt' | 'hash_mismatch' | 'download_failed' | 'aborted';

export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

export interface ModelPaths {
  /** The model's folder, once it is in place. */
  readonly dir: string;
  /** Where its files download first. */
  readonly partial: string;
  readonly lock: string;
}

export function modelPaths(manifest: ModelManifest, home: string = penmossHome()): ModelPaths {
  const models = join(home, 'models');
  const name = `${manifest.name}@${manifest.revision}`;
  return {
    dir: join(models, name),
    partial: join(models, `.${name}.partial`),
    lock: join(models, `.${name}.lock`),
  };
}

export interface ModelStatus {
  readonly state: 'absent' | 'partial' | 'ready';
  /** Bytes on disk: everything when ready, what has downloaded when partial. */
  readonly bytes: number;
  readonly totalBytes: number;
  readonly dir: string;
}

const size = async (path: string) => (await stat(path).catch(() => undefined))?.size ?? 0;

/** What is on disk, by size alone (cheap; opening the model checks the hashes). */
export async function modelStatus(
  manifest: ModelManifest,
  home: string = penmossHome(),
): Promise<ModelStatus> {
  const paths = modelPaths(manifest, home);
  const totalBytes = manifestBytes(manifest);
  const sizes = await Promise.all(manifest.files.map((file) => size(join(paths.dir, file.path))));
  if (sizes.every((bytes, i) => bytes === manifest.files[i]!.bytes)) {
    return { state: 'ready', bytes: totalBytes, totalBytes, dir: paths.dir };
  }
  const partial = await Promise.all(
    manifest.files.map(async (file) =>
      Math.max(
        await size(join(paths.partial, file.path)),
        await size(join(paths.partial, `${file.path}.part`)),
        // A folder in place with a file missing (deleted for a bad checksum).
        sizes[manifest.files.indexOf(file)]!,
      ),
    ),
  );
  const bytes = partial.reduce((sum, n) => sum + n, 0);
  return { state: bytes > 0 ? 'partial' : 'absent', bytes, totalBytes, dir: paths.dir };
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** True when `path` is `file` exactly: its size, then its hash. */
async function verify(path: string, file: ModelFile): Promise<boolean> {
  if ((await size(path)) !== file.bytes) return false;
  return (await sha256(path)) === file.sha256;
}

/**
 * The model's folder after checking every file's size and SHA-256 again (A1151). Throws
 * `absent` when it was never fetched and `corrupt` when a file is wrong.
 */
export async function openModel(
  manifest: ModelManifest,
  home: string = penmossHome(),
): Promise<string> {
  const { dir } = modelPaths(manifest, home);
  if ((await stat(dir).catch(() => undefined)) === undefined) {
    throw new ModelError('absent', `The model is not downloaded (${manifest.name}).`);
  }
  for (const file of manifest.files) {
    if (!(await verify(join(dir, file.path), file))) {
      // Deleted, so the next fetch downloads it again.
      await rm(join(dir, file.path), { force: true });
      throw new ModelError(
        'corrupt',
        `The model's ${file.path} did not match its checksum and was deleted; fetch the model again.`,
      );
    }
  }
  return dir;
}

export interface FetchProgress {
  /** Bytes in place, across every file (including ones resumed or already there). */
  readonly received: number;
  readonly total: number;
  readonly file: string;
}

export interface FetchOptions {
  readonly home?: string;
  /** Default `https://huggingface.co`; tests point it at a local server. */
  readonly baseUrl?: string;
  readonly onProgress?: (progress: FetchProgress) => void;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  /** A lock untouched this long belongs to a process that died (ms, default 30 s). */
  readonly staleLockMs?: number;
}

const HEARTBEAT_MS = 2_000;
const WAIT_MS = 250;

/**
 * Downloads the model if it is not in place, and returns its folder. Resumes a partial download,
 * refuses a file whose hash differs (deleting it, so the next try starts it again), and waits
 * while another process holds the download.
 */
export async function fetchModel(
  manifest: ModelManifest,
  options: FetchOptions = {},
): Promise<string> {
  const home = options.home ?? penmossHome();
  const paths = modelPaths(manifest, home);
  await mkdir(dirname(paths.dir), { recursive: true });
  for (;;) {
    if ((await modelStatus(manifest, home)).state === 'ready') return paths.dir;
    const release = await tryLock(paths.lock, options.staleLockMs ?? 30_000);
    if (!release) {
      if (options.signal?.aborted) throw new ModelError('aborted', 'The download was cancelled.');
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      continue;
    }
    try {
      if ((await modelStatus(manifest, home)).state === 'ready') return paths.dir;
      // A folder in place but incomplete: its good files are kept, only the rest downloads.
      if ((await stat(paths.partial).catch(() => undefined)) === undefined) {
        await rename(paths.dir, paths.partial).catch(() => undefined);
      }
      await download(manifest, paths, options);
      await rm(paths.dir, { recursive: true, force: true });
      await rename(paths.partial, paths.dir);
      return paths.dir;
    } finally {
      await release();
    }
  }
}

/** Takes the lock file, or answers undefined while a live process holds it. */
async function tryLock(path: string, staleMs: number): Promise<(() => Promise<void>) | undefined> {
  try {
    const handle = await open(path, 'wx');
    await handle.writeFile(String(process.pid));
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const held = await stat(path).catch(() => undefined);
    if (held && Date.now() - held.mtimeMs > staleMs) await unlink(path).catch(() => undefined);
    return undefined;
  }
  const beat = setInterval(() => {
    const now = new Date();
    void utimes(path, now, now).catch(() => undefined);
  }, HEARTBEAT_MS);
  beat.unref();
  return async () => {
    clearInterval(beat);
    await unlink(path).catch(() => undefined);
  };
}

async function download(
  manifest: ModelManifest,
  paths: ModelPaths,
  options: FetchOptions,
): Promise<void> {
  const fetcher = options.fetch ?? fetch;
  const base = (options.baseUrl ?? 'https://huggingface.co').replace(/\/$/, '');
  const total = manifestBytes(manifest);
  let done = 0;
  for (const file of manifest.files) {
    const target = join(paths.partial, file.path);
    const part = `${target}.part`;
    await mkdir(dirname(target), { recursive: true });
    if (await verify(target, file)) {
      done += file.bytes;
      options.onProgress?.({ received: done, total, file: file.path });
      continue;
    }
    await rm(target, { force: true });
    let have = await size(part);
    if (have > file.bytes) {
      await rm(part, { force: true });
      have = 0;
    }
    if (have < file.bytes) {
      const url = `${base}/${manifest.repo}/resolve/${manifest.revision}/${file.path}`;
      let response: Response;
      try {
        response = await fetcher(url, {
          headers: have > 0 ? { Range: `bytes=${have}-` } : {},
          signal: options.signal ?? null,
        });
      } catch (error) {
        if (options.signal?.aborted) throw new ModelError('aborted', 'The download was cancelled.');
        throw new ModelError(
          'download_failed',
          `Could not reach ${new URL(url).host}: ${String(error)}`,
        );
      }
      if (response.status !== 200 && response.status !== 206) {
        throw new ModelError(
          'download_failed',
          `${new URL(url).host} answered ${response.status} for ${file.path}.`,
        );
      }
      // A server that ignores the range sends the whole file again.
      if (response.status === 200) have = 0;
      // Each chunk is written before the next is read, so a dropped connection keeps what came.
      const out = await open(part, have > 0 ? 'a' : 'w');
      let received = have;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          await out.write(chunk);
          received += chunk.length;
          options.onProgress?.({ received: done + received, total, file: file.path });
        }
      } catch (error) {
        if (options.signal?.aborted) throw new ModelError('aborted', 'The download was cancelled.');
        throw new ModelError(
          'download_failed',
          `The download of ${file.path} stopped: ${String(error)}`,
        );
      } finally {
        await out.close();
      }
      if (received !== file.bytes) {
        throw new ModelError(
          'download_failed',
          `The download of ${file.path} stopped at ${received} of ${file.bytes} bytes.`,
        );
      }
    }
    if (!(await verify(part, file))) {
      await rm(part, { force: true });
      throw new ModelError(
        'hash_mismatch',
        `${file.path} did not match its pinned checksum; it was deleted.`,
      );
    }
    await rename(part, target);
    done += file.bytes;
    options.onProgress?.({ received: done, total, file: file.path });
  }
  await writeFile(join(paths.partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Deletes the model and any partial download. */
export async function removeModel(
  manifest: ModelManifest,
  home: string = penmossHome(),
): Promise<void> {
  const paths = modelPaths(manifest, home);
  await rm(paths.dir, { recursive: true, force: true });
  await rm(paths.partial, { recursive: true, force: true });
}

/** Model folders on disk other than this manifest's (older revisions, to offer removing). */
export async function otherModels(
  manifest: ModelManifest,
  home: string = penmossHome(),
): Promise<string[]> {
  const models = join(home, 'models');
  const own = `${manifest.name}@${manifest.revision}`;
  const names = await readdir(models).catch(() => [] as string[]);
  return names
    .filter((name) => !name.startsWith('.') && name !== own)
    .map((name) => join(models, name));
}
