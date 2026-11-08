/**
 * Auto-Update (T64 item 2, A1112, A1196): electron-updater's generic provider reads GitHub
 * Releases, public, so no token and no account. Two channels (P6 of the public-release plan):
 *
 * - Stable (the default): `latest-mac.yml` on the latest release,
 *   https://github.com/htxryan/penmoss/releases/latest/download/, which a `vX.Y.Z` release is.
 * - Alpha: `alpha-mac.yml` on the rolling `alpha` prerelease that every build from main replaces,
 *   https://github.com/htxryan/penmoss/releases/download/alpha/.
 *
 * The zip a feed names is fetched from beside it. Before A1196 the feed was
 * https://downloads.penmoss.app/mac (R2, A1112), and GitHub with the person's token before that
 * (A1015). Updates never go to an older version: setting electron-updater's `channel` turns on
 * `allowDowngrade`, so `point` turns it off again. An Alpha build switched to Stable stays on its
 * build until a stable release is newer.
 *
 * Settings → Updates has the switch, off until the person turns it on: then the app checks
 * 10 s after launch and every hour. Check Now works either way, and so does switching the
 * channel, which checks at once. A newer build is only offered: the app says so, and Install and
 * Restart downloads it and restarts into it. Nothing is downloaded before that.
 *
 * Only a signed build has an update feed (`app-update.yml`, written by electron-builder when the
 * build is signed, electron-builder.config.cjs): Squirrel.Mac refuses unsigned updates, so an
 * unsigned build never checks.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RELEASES_URL = 'https://github.com/htxryan/penmoss/releases';
export const CHECK_EVERY_MS = 60 * 60 * 1000;

export type UpdateMode = 'development' | 'unsigned' | 'enabled';

export function updateMode(packaged: boolean, resourcesPath: string): UpdateMode {
  if (!packaged) return 'development';
  return existsSync(join(resourcesPath, 'app-update.yml')) ? 'enabled' : 'unsigned';
}

export type UpdateChannel = 'stable' | 'alpha';

/** Where each channel's feed and zips are (P6). */
export const FEED_URLS: Readonly<Record<UpdateChannel, string>> = {
  stable: `${RELEASES_URL}/latest/download`,
  alpha: `${RELEASES_URL}/download/alpha`,
};

/** electron-updater's channel for each: its feed is `<channel>-mac.yml`. */
export const UPDATER_CHANNELS: Readonly<Record<UpdateChannel, string>> = {
  stable: 'latest',
  alpha: 'alpha',
};

/** A channel's feed: public, so no token goes with it. */
export function genericFeed(channel: UpdateChannel = 'stable') {
  return { provider: 'generic', url: FEED_URLS[channel] } as const;
}

/**
 * Points electron-updater at a channel's feed. Setting `channel` turns on `allowDowngrade`
 * (electron-updater's own rule, for leaving a beta), so it is turned off again: switching never
 * installs an older version.
 */
export function point(updater: Updater, channel: UpdateChannel): void {
  updater.setFeedURL(genericFeed(channel));
  updater.channel = UPDATER_CHANNELS[channel];
  updater.allowDowngrade = false;
}

export type UpdatePhase =
  'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';

/** What Settings → Updates and the update notice show (the bridge's `DesktopUpdateState`). */
export interface UpdateState {
  /** A signed build: it can check and install (otherwise nothing here works). */
  readonly supported: boolean;
  /** Auto-Update is on: checks at launch and every hour. */
  readonly auto: boolean;
  /** The update channel: Stable (the default) or Alpha. */
  readonly channel: UpdateChannel;
  /** This app's version (`X.Y.Z`, `X.Y.Z-alpha.<run>`, or `0.1.<run>` from before P5). */
  readonly current: string;
  readonly phase: UpdatePhase;
  /** The newer build's version, once one is found. */
  readonly version: string | null;
  /** How much of it is downloaded, 0–100, while downloading. */
  readonly percent: number | null;
  /** Why the last check or download failed. */
  readonly message: string | null;
  /** When the last check finished (ms since the epoch). */
  readonly checkedAt: number | null;
}

/** What `Updates` uses of electron-updater's `autoUpdater`. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  /** electron-updater's channel; setting it turns `allowDowngrade` on (`point`). */
  channel: string | null;
  allowDowngrade: boolean;
  setFeedURL(options: ReturnType<typeof genericFeed>): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', listener: () => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
}

export interface UpdatesOptions {
  readonly mode: () => UpdateMode;
  /** This app's version (`app.getVersion()`). */
  readonly version?: () => string;
  /** Where `updates.json` (the switch and the channel) is kept: the app's userData. */
  readonly dir: string;
  readonly load?: () => Promise<Updater>;
  readonly log: (message: string) => void;
  readonly onChange?: (state: UpdateState) => void;
  readonly every?: number;
  readonly now?: () => number;
}

const PREFS = 'updates.json';

export class Updates {
  private timer: ReturnType<typeof setInterval> | null = null;
  private updater: Updater | null = null;
  private auto = false;
  private channel: UpdateChannel = 'stable';
  private phase: UpdatePhase = 'idle';
  private version: string | null = null;
  private percent: number | null = null;
  private message: string | null = null;
  private checkedAt: number | null = null;
  /** Install and Restart was asked for: restart as soon as the download is in. */
  private installing = false;
  private loaded: Promise<void> | null = null;
  /** The check under way, settled whatever it finds. */
  private checking: Promise<void> | null = null;

  constructor(private readonly options: UpdatesOptions) {}

  private get supported(): boolean {
    return this.options.mode() === 'enabled';
  }

  state(): UpdateState {
    return {
      supported: this.supported,
      auto: this.auto,
      channel: this.channel,
      current: this.options.version?.() ?? '',
      phase: this.phase,
      version: this.version,
      percent: this.percent,
      message: this.message,
      checkedAt: this.checkedAt,
    };
  }

  /** The state, with the switch as stored (before `start`, too). */
  async current(): Promise<UpdateState> {
    await this.read();
    return this.state();
  }

  /** Reads the switch; called once the app is up, and checks if it is on. */
  async start(): Promise<void> {
    await this.read();
    this.options.log(
      `auto-update: ${this.options.mode()}, ${this.auto ? 'on' : 'off'}, ${this.channel}`,
    );
    this.follow();
  }

  /** The person turned Auto-Update on or off in Settings → Updates. */
  async setAuto(on: boolean): Promise<UpdateState> {
    await this.read();
    this.auto = on;
    await this.write();
    this.follow();
    this.changed();
    return this.state();
  }

  /**
   * The person chose Stable or Alpha in Settings → Updates: kept, and checked at once whether
   * Auto-Update is on or off. What the other channel offered is forgotten; the new one's build is
   * only offered, as ever. While a build is downloading or downloaded, the choice is kept for the
   * next check.
   */
  async setChannel(channel: UpdateChannel): Promise<UpdateState> {
    await this.read();
    if (channel === this.channel) return this.state();
    this.channel = channel;
    await this.write();
    if (this.updater) point(this.updater, channel);
    // A check of the other feed still under way finishes first; the new check replaces it.
    await this.checking;
    if (this.holding()) {
      this.changed();
      return this.state();
    }
    this.set({ phase: 'idle', version: null, percent: null, message: null });
    return this.check();
  }

  /** Checks now (Check Now, Check for Updates…): unless a newer build is already in hand. */
  async check(): Promise<UpdateState> {
    if (!this.supported) return this.state();
    if (this.phase === 'checking' || this.phase === 'downloading' || this.phase === 'ready') {
      return this.state();
    }
    const updater = await this.load();
    this.set({ phase: 'checking', message: null });
    const done = updater.checkForUpdates().then(
      () => undefined,
      (error: unknown) => this.failed(error),
    );
    this.checking = done;
    await done;
    if (this.checking === done) this.checking = null;
    return this.state();
  }

  /** Install and Restart: downloads the newer build, then restarts into it. */
  async install(): Promise<UpdateState> {
    if (!this.supported) return this.state();
    const updater = await this.load();
    if (this.phase === 'ready') {
      updater.quitAndInstall();
      return this.state();
    }
    if (this.phase !== 'available' && this.phase !== 'error') return this.state();
    if (this.version === null) return this.state();
    this.installing = true;
    this.set({ phase: 'downloading', percent: 0, message: null });
    try {
      await updater.downloadUpdate();
    } catch (error) {
      this.installing = false;
      this.failed(error);
    }
    return this.state();
  }

  /** A newer build is downloading or downloaded: it stays, whatever the channel. */
  private holding(): boolean {
    return this.phase === 'downloading' || this.phase === 'ready';
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Checks at once and every hour while the switch is on; stops when it goes off. */
  private follow(): void {
    if (!this.auto || !this.supported) {
      this.stop();
      return;
    }
    void this.check();
    if (!this.timer) {
      this.timer = setInterval(() => void this.check(), this.options.every ?? CHECK_EVERY_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  private read(): Promise<void> {
    this.loaded ??= readFile(join(this.options.dir, PREFS), 'utf8')
      .then((text) => {
        const value = JSON.parse(text) as { auto?: unknown; channel?: unknown };
        this.auto = value.auto === true;
        this.channel = value.channel === 'alpha' ? 'alpha' : 'stable';
      })
      .catch(() => {
        this.auto = false;
        this.channel = 'stable';
      });
    return this.loaded;
  }

  private async write(): Promise<void> {
    await mkdir(this.options.dir, { recursive: true });
    const path = join(this.options.dir, PREFS);
    const next = `${path}.${process.pid}.tmp`;
    await writeFile(next, `${JSON.stringify({ auto: this.auto, channel: this.channel })}\n`);
    await rename(next, path);
  }

  private set(
    patch: Partial<Omit<UpdateState, 'supported' | 'auto' | 'channel' | 'current'>>,
  ): void {
    if (patch.phase !== undefined) this.phase = patch.phase;
    if (patch.version !== undefined) this.version = patch.version;
    if (patch.percent !== undefined) this.percent = patch.percent;
    if (patch.message !== undefined) this.message = patch.message;
    if (patch.checkedAt !== undefined) this.checkedAt = patch.checkedAt;
    this.changed();
  }

  private changed(): void {
    this.options.onChange?.(this.state());
  }

  private failed(error: unknown): void {
    // The message, not the request: electron-updater's errors can quote the URL.
    const message = error instanceof Error ? error.message : String(error);
    // No feed on the channel yet (no stable release, or no Alpha build): said plainly.
    const missing =
      (error as { code?: unknown } | null)?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
    this.options.log(`update failed: ${message}`);
    // An Alpha build on Stable before the first stable release: nothing newer, which the page
    // says as "moves to Stable with the next stable release" rather than as a failure.
    if (missing && this.version === null && this.channel === 'stable' && this.onAlphaBuild()) {
      this.set({ phase: 'current', percent: null, message: null, checkedAt: this.now() });
      return;
    }
    this.set({
      phase: this.version !== null ? 'available' : 'error',
      percent: null,
      message: missing
        ? `no ${this.channel === 'alpha' ? 'Alpha build' : 'stable release'} is published yet`
        : firstLine(message),
      checkedAt: this.now(),
    });
  }

  /** This app is a build from main (`X.Y.Z-alpha.<build>`), not a stable release. */
  private onAlphaBuild(): boolean {
    return /^\d+\.\d+\.\d+-/.test(this.options.version?.() ?? '');
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async load(): Promise<Updater> {
    if (this.updater) return this.updater;
    const updater = this.options.load
      ? await this.options.load()
      : ((await import('electron-updater')).autoUpdater as unknown as Updater);
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    await this.read();
    point(updater, this.channel);
    updater.on('error', (error) => {
      // A check's or download's failure is reported where it was awaited too; this catches
      // what electron-updater reports on its own.
      if (this.phase === 'checking' || this.phase === 'downloading') this.failed(error);
    });
    updater.on('update-available', (info) => {
      this.options.log(`update ${info.version} is available`);
      this.set({ phase: 'available', version: info.version, checkedAt: this.now() });
    });
    updater.on('update-not-available', () =>
      this.set({ phase: 'current', version: null, checkedAt: this.now() }),
    );
    updater.on('download-progress', (progress) =>
      this.set({ percent: Math.max(0, Math.min(100, Math.round(progress.percent))) }),
    );
    updater.on('update-downloaded', (info) => {
      this.options.log(`update ${info.version} downloaded`);
      this.set({ phase: 'ready', version: info.version, percent: 100 });
      if (this.installing) updater.quitAndInstall();
    });
    this.updater = updater;
    return updater;
  }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
