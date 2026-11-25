/**
 * The Mac app's log file (PEN-137, Local logs): `~/Library/Logs/Penmoss/penmoss.log`, written
 * whatever the analytics answer, and leaving the Mac only when attached to a bug report. Each
 * line is `<ISO time> <level> <source> <message>`, scrubbed as it is written (scrub #1: tokens,
 * emails, repository URLs, paths, quoted text, ids, and the GitHub login and notebook names main
 * knows), and appended through an async file handle: nothing here is synchronous, so the main
 * thread never waits on the disk.
 *
 * Kept within the limits (`logs.fileKb`, `logs.files`, `logs.days`): a full file rotates
 * (`penmoss.log` → `penmoss.1.log` …, the oldest dropped; with one file kept, its older half
 * goes), and hourly the lines older than the age limit go: expired rotated files are deleted
 * and the oldest one left loses its head by a streaming copy. Every change to the files runs in
 * one queue, after the writes before it.
 *
 * A bug report reads it backwards, 64 KB at a time across the files, newest first, never a
 * whole file (`report`), and scrubs what it attaches again with the note titles, folders, tags
 * and attachment names the page sends (scrub #2).
 *
 * Only the app writes it: the CLI (`cli-mode.ts`) and the MCP server keep logging to stderr.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  createScrubber,
  DEFAULT_LIMITS,
  LIMIT_KB,
  lineTime,
  reportHours,
  reportLines,
  textBytes,
  type Limits,
  type ScrubKnown,
  type Scrubber,
} from '@penmoss/core/analytics';

export type LogLevel = 'info' | 'warn' | 'error';

export type LogLimits = Pick<Limits, 'logs.fileKb' | 'logs.files' | 'logs.days'>;

const LOG_FILE = 'penmoss.log';
/** Bytes read at a time, backwards or forwards. */
const CHUNK = 64 * 1024;
/** The longest message a line keeps (characters). */
const MAX_MESSAGE = 4000;
/** A scrubber numbers repositories and ids; a fresh one after this many lines keeps it small. */
const SCRUBBER_LINES = 500;

const DAY = 86_400_000;
const NAME = /^penmoss(?:\.(\d{1,2}))?\.log$/;

/** The file at `index`: 0 is `penmoss.log`, then `penmoss.1.log`, `penmoss.2.log`… */
export function logFileName(index: number): string {
  return index === 0 ? LOG_FILE : `penmoss.${index}.log`;
}

interface LogFileOptions {
  readonly dir: string;
  readonly limits?: LogLimits;
  /** What scrub #1 knows: the GitHub login, the notebooks' names, repositories and branches. */
  readonly known?: ScrubKnown;
  readonly now?: () => number;
  /** How often the age limit is enforced (ms); 0: only when asked (tests). */
  readonly ageEveryMs?: number;
}

/** The newest lines a bug report attaches, after scrub #2. */
export interface ReportLogs {
  readonly lines: readonly string[];
  readonly bytes: number;
}

/** The lines of `path`, newest first, read backwards a chunk at a time. */
export async function* linesBackwards(path: string, chunk = CHUNK): AsyncGenerator<string> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch {
    return;
  }
  try {
    const { size } = await handle.stat();
    let position = size;
    let rest = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(chunk, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      const data = rest.length > 0 ? Buffer.concat([buffer, rest]) : buffer;
      let end = data.length;
      for (let index = data.length - 1; index >= 0; index--) {
        if (data[index] !== 0x0a) continue;
        if (index + 1 < end) yield data.toString('utf8', index + 1, end);
        end = index;
      }
      rest = Buffer.from(data.subarray(0, end));
    }
    if (rest.length > 0) yield rest.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Where the first line at or after `cutoff` starts in `path` (a line without a time belongs to
 * the line before it), reading forwards from the start; the file's size when every line is older.
 */
export async function offsetFrom(path: string, cutoff: number): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    let position = 0;
    let lineStart = 0;
    let pending = Buffer.alloc(0);
    while (position < size) {
      const length = Math.min(CHUNK, size - position);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      position += length;
      const data = pending.length > 0 ? Buffer.concat([pending, buffer]) : buffer;
      let start = 0;
      for (let index = 0; index < data.length; index++) {
        if (data[index] !== 0x0a) continue;
        const time = lineTime(data.toString('utf8', start, Math.min(index, start + 40)) + ' ');
        if (time !== null && time >= cutoff) return lineStart;
        lineStart += index + 1 - start;
        start = index + 1;
      }
      pending = Buffer.from(data.subarray(start));
    }
    if (pending.length > 0) {
      const time = lineTime(pending.toString('utf8', 0, Math.min(pending.length, 40)) + ' ');
      if (time !== null && time >= cutoff) return lineStart;
    }
    return size;
  } finally {
    await handle.close();
  }
}

/** Where the line after byte `from` starts (so a cut keeps whole lines); the size if none. */
async function lineAfter(path: string, from: number): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    let position = Math.max(0, from);
    while (position < size) {
      const length = Math.min(CHUNK, size - position);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      const index = buffer.indexOf(0x0a);
      if (index !== -1) return position + index + 1;
      position += length;
    }
    return size;
  } finally {
    await handle.close();
  }
}

/**
 * Keeps `path` from byte `offset` on, by a streaming copy renamed over it. The copy keeps the
 * file's times: its newest line is as old as it was.
 */
async function dropHead(path: string, offset: number): Promise<void> {
  if (offset <= 0) return;
  const info = await stat(path);
  if (offset >= info.size) {
    await unlink(path);
    return;
  }
  const temporary = `${path}.trim`;
  await pipeline(
    createReadStream(path, { start: offset }),
    createWriteStream(temporary, { mode: 0o600 }),
  );
  await utimes(temporary, info.atime, info.mtime);
  await rename(temporary, path);
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export class LogFile {
  readonly path: string;
  private limits: LogLimits;
  private known: ScrubKnown;
  private scrubber: Scrubber | null = null;
  private scrubbedLines = 0;
  private readonly now: () => number;
  private queue: string[] = [];
  private draining = false;
  private chain: Promise<void> = Promise.resolve();
  private handle: FileHandle | null = null;
  /** The current file's size, once it is open. */
  private size = 0;
  private ageTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly options: LogFileOptions) {
    this.path = join(options.dir, LOG_FILE);
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.known = options.known ?? {};
    this.now = options.now ?? Date.now;
    const every = options.ageEveryMs ?? 3_600_000;
    if (every > 0) {
      this.ageTimer = setInterval(() => void this.enforceAge().catch(() => undefined), every);
      this.ageTimer.unref?.();
    }
  }

  get dir(): string {
    return this.options.dir;
  }

  /** What scrub #1 knows from now on. */
  setKnown(known: ScrubKnown): void {
    this.known = known;
    this.scrubber = null;
  }

  /** The limits in force; the files are brought within them (`apply`). */
  get currentLimits(): LogLimits {
    return this.limits;
  }

  private scrub(message: string): string {
    if (!this.scrubber || this.scrubbedLines >= SCRUBBER_LINES) {
      this.scrubber = createScrubber(this.known);
      this.scrubbedLines = 0;
    }
    this.scrubbedLines += 1;
    return this.scrubber.line(message);
  }

  /** Appends one line, scrubbed; never throws and never waits. */
  write(level: LogLevel, source: string, message: string): void {
    if (this.closed) return;
    try {
      const text = message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message;
      const tag = source.replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'main';
      const line = `${new Date(this.now()).toISOString()} ${level} ${tag} ${this.scrub(text)}\n`;
      this.queue.push(line);
      if (!this.draining) {
        this.draining = true;
        void this.run(() => this.drain()).catch(() => undefined);
      }
    } catch {
      // Logging never breaks the app.
    }
  }

  /** Runs `job` after every write and change queued before it. */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private maxBytes(limits: LogLimits = this.limits): number {
    return limits['logs.fileKb'] * LIMIT_KB;
  }

  private async openCurrent(): Promise<FileHandle> {
    if (this.handle) return this.handle;
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    const handle = await open(this.path, 'a', 0o600);
    this.size = (await handle.stat()).size;
    this.handle = handle;
    return handle;
  }

  private async closeCurrent(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    await handle?.close().catch(() => undefined);
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const lines = this.queue.splice(0, 2000);
        let batch = '';
        let batchBytes = 0;
        for (const line of lines) {
          const bytes = Buffer.byteLength(line);
          await this.openCurrent();
          if (this.size + batchBytes + bytes > this.maxBytes() && this.size + batchBytes > 0) {
            if (batch) await this.append(batch, batchBytes);
            batch = '';
            batchBytes = 0;
            await this.rotate();
          }
          batch += line;
          batchBytes += bytes;
        }
        if (batch) await this.append(batch, batchBytes);
      }
    } catch {
      // A disk that refuses (full, read-only): the lines are dropped, the app goes on.
      this.queue = [];
      await this.closeCurrent();
    } finally {
      this.draining = false;
      if (this.queue.length > 0 && !this.closed) {
        this.draining = true;
        void this.run(() => this.drain()).catch(() => undefined);
      }
    }
  }

  private async append(text: string, bytes: number): Promise<void> {
    const handle = await this.openCurrent();
    await handle.write(text);
    this.size += bytes;
  }

  /** The files there are, by index (0 is the current one). */
  private async present(): Promise<number[]> {
    let names: string[];
    try {
      names = await readdir(this.options.dir);
    } catch {
      return [];
    }
    return names
      .map((name) => NAME.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => (match[1] === undefined ? 0 : Number(match[1])))
      .sort((a, b) => a - b);
  }

  private file(index: number): string {
    return join(this.options.dir, logFileName(index));
  }

  /**
   * The current file is full: it becomes `penmoss.1.log`, and each older one moves up, the
   * oldest kept dropped. With one file kept, its older half goes instead.
   */
  private async rotate(): Promise<void> {
    const files = this.limits['logs.files'];
    await this.closeCurrent();
    if (files <= 1) {
      const size = await sizeOf(this.path);
      await dropHead(this.path, await lineAfter(this.path, Math.floor(size / 2)));
    } else {
      for (const index of (await this.present()).reverse()) {
        if (index === 0) continue;
        if (index >= files - 1) await unlink(this.file(index)).catch(() => undefined);
        else await rename(this.file(index), this.file(index + 1)).catch(() => undefined);
      }
      await rename(this.path, this.file(1)).catch(() => undefined);
    }
    await this.openCurrent();
  }

  /** Waits for every line written so far to reach the file. */
  flushed(): Promise<void> {
    return this.run(() => Promise.resolve());
  }

  /** The files' total size in bytes. */
  async bytes(): Promise<number> {
    await this.flushed();
    let total = 0;
    for (const index of await this.present()) total += await sizeOf(this.file(index));
    return total;
  }

  /**
   * What `limits` would delete now, in bytes: files beyond the count, lines older than the age
   * (whole files, then the oldest kept file's head) and what each kept file holds beyond the
   * size.
   */
  async preview(limits: LogLimits): Promise<number> {
    await this.flushed();
    const cutoff = this.now() - limits['logs.days'] * DAY;
    const max = this.maxBytes(limits);
    let removed = 0;
    let headChecked = false;
    for (const index of (await this.present()).reverse()) {
      const path = this.file(index);
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (index >= limits['logs.files'] || info.mtimeMs < cutoff) {
        removed += info.size;
        continue;
      }
      let kept = info.size;
      if (!headChecked) {
        const offset = await offsetFrom(path, cutoff).catch(() => 0);
        removed += offset;
        kept -= offset;
        // A file whose every line is older goes whole; the next one's head is checked then.
        if (kept <= 0) continue;
        headChecked = true;
      }
      if (kept > max) removed += kept - max;
    }
    return removed;
  }

  /** Brings the files within `limits` (and keeps them for what follows). */
  apply(limits: LogLimits): Promise<void> {
    this.limits = limits;
    return this.run(async () => {
      const max = this.maxBytes(limits);
      for (const index of (await this.present()).reverse()) {
        const path = this.file(index);
        if (index >= limits['logs.files']) {
          if (index === 0) await this.closeCurrent();
          await unlink(path).catch(() => undefined);
          continue;
        }
        const size = await sizeOf(path);
        if (size <= max) continue;
        if (index === 0) await this.closeCurrent();
        await dropHead(path, await lineAfter(path, size - max));
      }
      await this.trimByAge(limits);
    });
  }

  /** Deletes the lines older than the age limit, off the main thread's way (hourly). */
  enforceAge(): Promise<void> {
    return this.run(() => this.trimByAge(this.limits));
  }

  private async trimByAge(limits: LogLimits): Promise<void> {
    const cutoff = this.now() - limits['logs.days'] * DAY;
    for (const index of (await this.present()).reverse()) {
      const path = this.file(index);
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (info.size === 0) return;
      if (info.mtimeMs < cutoff) {
        if (index === 0) await this.closeCurrent();
        await unlink(path).catch(() => undefined);
        continue;
      }
      // The oldest file left: only its head can be older than the cutoff.
      const offset = await offsetFrom(path, cutoff);
      if (offset >= info.size) {
        if (index === 0) await this.closeCurrent();
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (offset > 0) {
        if (index === 0) await this.closeCurrent();
        await dropHead(path, offset);
      }
      return;
    }
  }

  /**
   * The lines a bug report attaches now: the newest from the last `report.hours` (no more than
   * the logs keep), read backwards across the files, scrubbed again with `names` and what scrub
   * #1 knows, then cut to `report.lines` and `report.kb`.
   */
  async report(
    limits: Limits,
    names: readonly string[] = [],
    known: ScrubKnown = this.known,
  ): Promise<ReportLogs> {
    await this.flushed();
    const now = this.now();
    const since = now - reportHours(limits) * 3_600_000;
    const maxLines = limits['report.lines'];
    // Scrub #2 may shorten a line: twice the bytes are read, and `reportLines` cuts after it.
    const maxBytes = limits['report.kb'] * LIMIT_KB * 2;
    const newest: string[] = [];
    let bytes = 0;
    reading: for (const index of await this.present()) {
      for await (const line of linesBackwards(this.file(index))) {
        if (line === '') continue;
        const time = lineTime(line);
        if (time !== null && time < since) break reading;
        newest.push(line);
        bytes += Buffer.byteLength(line) + 1;
        if (newest.length >= maxLines || bytes >= maxBytes) break reading;
      }
    }
    const lines = newest.reverse();
    // Only the names that appear: a notebook's thousands of titles would slow every line.
    const text = lines.join('\n').toLowerCase();
    const present = names.filter(
      (name) => name.trim().length > 0 && text.includes(name.trim().toLowerCase()),
    );
    const scrubber = createScrubber({ ...known, names: [...(known.names ?? []), ...present] });
    const attached = reportLines(
      lines.map((line) => scrubber.line(line)),
      limits,
      now,
    );
    return { lines: attached, bytes: textBytes(attached) };
  }

  /** Writes what waits and closes the file (the app quits). */
  async close(): Promise<void> {
    if (this.ageTimer) clearInterval(this.ageTimer);
    await this.flushed();
    this.closed = true;
    await this.run(() => this.closeCurrent());
  }
}

/** At most `perMinute` lines a minute from one source (the pages' console and error ring). */
export class LineBudget {
  private readonly recent: number[] = [];
  private dropped = 0;

  constructor(
    private readonly perMinute = 50,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether one more line may be written now; counts it when it may. */
  take(): boolean {
    const now = this.now();
    while (this.recent.length > 0 && now - this.recent[0]! >= 60_000) this.recent.shift();
    if (this.recent.length >= this.perMinute) {
      this.dropped += 1;
      return false;
    }
    this.recent.push(now);
    return true;
  }

  /** How many were refused since the last call (to say so once in the log). */
  takeDropped(): number {
    const dropped = this.dropped;
    this.dropped = 0;
    return dropped;
  }
}
