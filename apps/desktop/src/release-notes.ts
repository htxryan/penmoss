/**
 * Release notes for Settings → Updates (PEN-108, A-NEW): main fetches `release-notes.json` from
 * beside the current channel's update feed (FEED_URLS, so the same public GitHub host and no
 * token), keeps it in userData so the notes read offline, and hands it to the page over the
 * bridge. The page never reaches the network (A293).
 *
 * It fetches on every update check and when Settings opens, at most once an hour per channel
 * (switching channel fetches the other file at once). A file that doesn't read as a notes file
 * keeps the cached one. A development build never fetches: it reads the cache only, which the
 * Electron suite writes.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FEED_URLS, type UpdateChannel, type UpdateMode } from './updater';

export const NOTES_FILE = 'release-notes.json';
export const NOTES_EVERY_MS = 60 * 60 * 1000;
/** The largest file read: the record grows by a few notes a build, so this is years of them. */
export const NOTES_MAX_BYTES = 4 * 1024 * 1024;

export type NoteKind = 'new' | 'improved' | 'fixed';
export type NotePlatform = 'mac' | 'android';

export interface ReleaseNote {
  readonly build: number;
  readonly pr: number;
  readonly kind: NoteKind;
  readonly platform: NotePlatform | null;
  readonly text: string;
}

export interface ReleaseNotesRelease {
  readonly version: string;
  readonly tag: string;
  readonly build: number;
  readonly date: string;
}

/** What the page gets (the bridge's `DesktopReleaseNotes`). */
export interface ReleaseNotesFile {
  readonly schema: number;
  readonly generated: string;
  readonly notes: readonly ReleaseNote[];
  readonly releases: readonly ReleaseNotesRelease[];
}

const KINDS: readonly unknown[] = ['new', 'improved', 'fixed'];
const PLATFORMS: readonly unknown[] = ['mac', 'android', null];

const isBuild = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

function note(value: unknown): ReleaseNote | null {
  const v = value as Partial<Record<keyof ReleaseNote, unknown>> | null;
  if (!v || typeof v !== 'object') return null;
  if (!isBuild(v.build) || !isBuild(v.pr) || !KINDS.includes(v.kind)) return null;
  if (!PLATFORMS.includes(v.platform ?? null) || typeof v.text !== 'string') return null;
  return {
    build: v.build,
    pr: v.pr,
    kind: v.kind as NoteKind,
    platform: (v.platform ?? null) as NotePlatform | null,
    text: v.text,
  };
}

function release(value: unknown): ReleaseNotesRelease | null {
  const v = value as Partial<Record<keyof ReleaseNotesRelease, unknown>> | null;
  if (!v || typeof v !== 'object') return null;
  if (typeof v.version !== 'string' || typeof v.tag !== 'string' || !isBuild(v.build)) return null;
  return {
    version: v.version,
    tag: v.tag,
    build: v.build,
    date: typeof v.date === 'string' ? v.date : '',
  };
}

/**
 * A notes file as the page may read it, or null when it isn't one. A newer schema is kept as
 * just its number, so the page says to read the notes on GitHub; schema 1 must be whole.
 */
export function parseNotes(text: string): ReleaseNotesFile | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const v = value as { schema?: unknown; generated?: unknown; notes?: unknown; releases?: unknown };
  if (!v || typeof v !== 'object' || !isBuild(v.schema) || v.schema < 1) return null;
  if (v.schema > 1) return { schema: v.schema, generated: '', notes: [], releases: [] };
  if (!Array.isArray(v.notes) || !Array.isArray(v.releases)) return null;
  const notes = v.notes.map(note);
  const releases = v.releases.map(release);
  if (notes.includes(null) || releases.includes(null)) return null;
  return {
    schema: 1,
    generated: typeof v.generated === 'string' ? v.generated : '',
    notes: notes as ReleaseNote[],
    releases: releases as ReleaseNotesRelease[],
  };
}

export interface ReleaseNotesOptions {
  /** Where the cache is kept: the app's userData. */
  readonly dir: string;
  readonly mode: () => UpdateMode;
  readonly fetch?: (
    url: string,
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  readonly log: (message: string) => void;
  readonly onChange?: (file: ReleaseNotesFile) => void;
  readonly every?: number;
  readonly now?: () => number;
}

export class ReleaseNotes {
  private file: ReleaseNotesFile | null = null;
  private loaded: Promise<void> | null = null;
  /** When each channel's file was last asked for. */
  private readonly fetched = new Map<UpdateChannel, number>();
  private fetching: Promise<void> | null = null;

  constructor(private readonly options: ReleaseNotesOptions) {}

  /** The cached file, read from userData the first time. */
  async current(): Promise<ReleaseNotesFile | null> {
    await this.read();
    return this.file;
  }

  /**
   * Fetches the channel's file unless it was asked for in the last hour (or this is a
   * development build), and keeps it if it reads. Never throws: a failure keeps the cache.
   */
  async refresh(channel: UpdateChannel): Promise<void> {
    if (this.options.mode() === 'development') return;
    const now = this.now();
    const last = this.fetched.get(channel);
    if (last !== undefined && now - last < (this.options.every ?? NOTES_EVERY_MS)) return;
    if (this.fetching) return this.fetching;
    this.fetched.set(channel, now);
    this.fetching = this.fetchOnce(channel).finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  private async fetchOnce(channel: UpdateChannel): Promise<void> {
    const url = `${FEED_URLS[channel]}/${NOTES_FILE}`;
    try {
      await this.read();
      const get = this.options.fetch ?? ((target: string) => fetch(target));
      const response = await get(url);
      if (!response.ok) {
        // 404: no release carries a notes file yet.
        this.options.log(`release notes: ${channel} answered ${response.status}`);
        return;
      }
      const text = await response.text();
      if (text.length > NOTES_MAX_BYTES) {
        this.options.log(`release notes: ${channel}'s file is too big; keeping the cache`);
        return;
      }
      const file = parseNotes(text);
      if (!file) {
        this.options.log(`release notes: ${channel}'s file doesn't read; keeping the cache`);
        return;
      }
      if (JSON.stringify(file) === JSON.stringify(this.file)) return;
      this.file = file;
      await this.write(text);
      this.options.onChange?.(file);
    } catch (error) {
      this.options.log(
        `release notes: ${channel} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private read(): Promise<void> {
    this.loaded ??= readFile(join(this.options.dir, NOTES_FILE), 'utf8')
      .then((text) => {
        this.file = parseNotes(text);
      })
      .catch(() => {
        this.file = null;
      });
    return this.loaded;
  }

  private async write(text: string): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    const path = join(this.options.dir, NOTES_FILE);
    const next = `${path}.${process.pid}.tmp`;
    await writeFile(next, text);
    await rename(next, path);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
