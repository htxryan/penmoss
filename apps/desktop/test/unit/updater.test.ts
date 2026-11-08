import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppUpdater } from 'electron-updater';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_EVERY_MS,
  FEED_URLS,
  genericFeed,
  point,
  Updates,
  type UpdateChannel,
  type Updater,
  type UpdateState,
} from '../../src/updater';

// Auto-Update (T64 item 2, A1112, A1196): public feeds on GitHub Releases, Stable (the default)
// or Alpha, a switch that is off until turned on, hourly checks while it is on, and a newer build
// only offered until Install and Restart. Never an older one.

type Listener = (value?: unknown) => void;

function fakeUpdater(next: { version: string | null } = { version: null }) {
  const listeners = new Map<string, Listener[]>();
  const emit = (event: string, value?: unknown) =>
    listeners.get(event)?.forEach((listener) => listener(value));
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: false,
    /** Every channel set, in order. */
    channels: [] as Array<string | null>,
    // As electron-updater's own: setting the channel turns downgrades on.
    get channel(): string | null {
      return this.channels.at(-1) ?? null;
    },
    set channel(value: string | null) {
      this.channels.push(value);
      this.allowDowngrade = true;
    },
    feeds: [] as unknown[],
    checks: 0,
    downloads: 0,
    installs: 0,
    next,
    fail: null as Error | null,
    setFeedURL(options: unknown) {
      this.feeds.push(options);
    },
    checkForUpdates() {
      this.checks++;
      if (this.fail) return Promise.reject(this.fail);
      if (this.next.version) emit('update-available', { version: this.next.version });
      else emit('update-not-available');
      return Promise.resolve(null);
    },
    downloadUpdate() {
      this.downloads++;
      emit('download-progress', { percent: 41.6 });
      emit('update-downloaded', { version: this.next.version });
      return Promise.resolve([]);
    },
    quitAndInstall() {
      this.installs++;
    },
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return updater;
    },
  };
  return updater;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'penmoss-updates-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

function updatesWith(
  updater: ReturnType<typeof fakeUpdater>,
  mode = 'enabled' as const,
  version = '0.2.0',
) {
  const states: UpdateState[] = [];
  const updates = new Updates({
    mode: () => mode,
    version: () => version,
    dir,
    load: () => Promise.resolve(updater as unknown as Updater),
    log: () => undefined,
    onChange: (state) => states.push(state),
    now: () => 1_000,
  });
  return { updates, states };
}

const prefs = async () => JSON.parse(await readFile(join(dir, 'updates.json'), 'utf8')) as unknown;

/** electron-updater's own updater, with a stand-in app: it never goes to the network. */
class RealUpdater extends AppUpdater {
  constructor(version: string, root: string) {
    super(null, {
      version,
      name: 'Penmoss',
      isPackaged: false,
      appUpdateConfigPath: join(root, 'app-update.yml'),
      userDataPath: root,
      baseCachePath: root,
      whenReady: () => Promise.resolve(),
      relaunch: () => undefined,
      quit: () => undefined,
      onQuit: () => undefined,
    });
  }
  protected doDownloadUpdate(): Promise<string[]> {
    return Promise.resolve([]);
  }
  quitAndInstall(): void {}
  /** What it would do with a feed naming `version`. */
  offers(version: string): Promise<boolean> {
    return (
      this as unknown as { isUpdateAvailable(info: { version: string }): Promise<boolean> }
    ).isUpdateAvailable({ version });
  }
  /** The feed file and the base URL its provider reads. */
  async feed(): Promise<{ file: string; url: string; headers: unknown }> {
    const provider = (await (this as unknown as { clientPromise: Promise<unknown> })
      .clientPromise) as { channel: string; baseUrl: URL; requestHeaders: unknown };
    return { file: provider.channel, url: provider.baseUrl.href, headers: provider.requestHeaders };
  }
}

describe('Auto-Update (A1112, A1196)', () => {
  it("reads each channel's public feed on GitHub Releases, with no token", () => {
    expect(genericFeed('stable')).toEqual({
      provider: 'generic',
      url: 'https://github.com/htxryan/penmoss/releases/latest/download',
    });
    expect(genericFeed('alpha')).toEqual({
      provider: 'generic',
      url: 'https://github.com/htxryan/penmoss/releases/download/alpha',
    });
    // Stable is the default.
    expect(genericFeed()).toEqual(genericFeed('stable'));
    expect(Object.keys(FEED_URLS)).toEqual(['stable', 'alpha']);
  });

  it('is off until turned on; then checks at once and every hour, and stops when turned off', async () => {
    vi.useFakeTimers();
    const updater = fakeUpdater();
    const { updates } = updatesWith(updater);
    await updates.start();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(updater.checks).toBe(0);
    expect((await updates.current()).auto).toBe(false);

    await updates.setAuto(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.checks).toBe(1);
    expect(updater.feeds).toEqual([genericFeed('stable')]);
    // Never downloads by itself.
    expect(updater.autoDownload).toBe(false);
    expect(updates.state()).toMatchObject({ phase: 'current', checkedAt: 1_000 });
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(updater.checks).toBe(2);
    expect(await prefs()).toEqual({ auto: true, channel: 'stable' });

    await updates.setAuto(false);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 3);
    expect(updater.checks).toBe(2);
  });

  it('remembers the switch across launches', async () => {
    vi.useFakeTimers();
    await writeFile(join(dir, 'updates.json'), '{"auto":true}\n');
    const updater = fakeUpdater();
    const { updates } = updatesWith(updater);
    await updates.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.checks).toBe(1);
    updates.stop();
  });

  it('offers a newer build, and downloads and restarts into it only on Install and Restart', async () => {
    const updater = fakeUpdater({ version: '0.2.1' });
    const { updates, states } = updatesWith(updater);
    expect(await updates.check()).toMatchObject({ phase: 'available', version: '0.2.1' });
    expect(updater.downloads).toBe(0);
    await updates.install();
    expect(updater.downloads).toBe(1);
    expect(updater.installs).toBe(1);
    expect(states.map((state) => state.phase)).toEqual([
      'checking',
      'available',
      'downloading',
      'downloading',
      'ready',
    ]);
    expect(states.find((state) => state.percent === 42)).toBeTruthy();
  });

  it('says why a check failed, in one line', async () => {
    const updater = fakeUpdater();
    updater.fail = new Error('net::ERR_INTERNET_DISCONNECTED\n  at stack');
    const { updates } = updatesWith(updater);
    expect(await updates.check()).toMatchObject({
      phase: 'error',
      message: 'net::ERR_INTERNET_DISCONNECTED',
    });
  });

  it('says plainly when a channel has nothing published yet', async () => {
    const updater = fakeUpdater();
    updater.fail = Object.assign(
      new Error('Cannot find channel "latest-mac.yml" update info: HttpError: 404'),
      { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' },
    );
    const { updates } = updatesWith(updater);
    expect(await updates.check()).toMatchObject({
      phase: 'error',
      message: 'no stable release is published yet',
    });
    expect(await updates.setChannel('alpha')).toMatchObject({
      phase: 'error',
      message: 'no Alpha build is published yet',
    });
  });

  it('on an Alpha build before the first stable release, Stable has nothing newer, not an error', async () => {
    const updater = fakeUpdater();
    updater.fail = Object.assign(
      new Error('Cannot find channel "latest-mac.yml" update info: HttpError: 404'),
      { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' },
    );
    const { updates } = updatesWith(updater, 'enabled', '0.2.0-alpha.1412');
    expect(await updates.check()).toMatchObject({
      channel: 'stable',
      phase: 'current',
      message: null,
      checkedAt: 1_000,
    });
    // Alpha with no feed is still said to be missing.
    expect(await updates.setChannel('alpha')).toMatchObject({
      phase: 'error',
      message: 'no Alpha build is published yet',
    });
  });

  it('never checks or installs in a build without a feed', async () => {
    const updater = fakeUpdater({ version: '0.2.1' });
    const { updates } = updatesWith(updater, 'unsigned' as never);
    await updates.setAuto(true);
    await updates.setChannel('alpha');
    await updates.check();
    await updates.install();
    expect(updater.checks + updater.downloads + updater.installs).toBe(0);
    expect(updates.state().supported).toBe(false);
  });
});

describe('the update channel (A1196)', () => {
  it('is Stable by default: latest-mac.yml on the latest release, downgrades off', async () => {
    const updater = fakeUpdater();
    const { updates } = updatesWith(updater);
    expect((await updates.current()).channel).toBe('stable');
    await updates.check();
    expect(updater.feeds).toEqual([genericFeed('stable')]);
    expect(updater.channels).toEqual(['latest']);
    expect(updater.allowDowngrade).toBe(false);
  });

  it('switching to Alpha is kept, checks at once with Auto-Update off, and only offers', async () => {
    const updater = fakeUpdater({ version: '0.2.1-alpha.12' });
    const { updates, states } = updatesWith(updater);
    await updates.start();
    expect(updater.checks).toBe(0);

    const state = await updates.setChannel('alpha');
    expect(state).toMatchObject({
      channel: 'alpha',
      phase: 'available',
      version: '0.2.1-alpha.12',
    });
    expect(updater.checks).toBe(1);
    expect(updater.feeds.at(-1)).toEqual(genericFeed('alpha'));
    expect(updater.channels.at(-1)).toBe('alpha');
    // Setting the channel turned downgrades on; they are off again.
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.downloads + updater.installs).toBe(0);
    expect(states.map((each) => each.phase)).toContain('checking');
    expect(await prefs()).toEqual({ auto: false, channel: 'alpha' });
    // Choosing the same channel again does nothing.
    await updates.setChannel('alpha');
    expect(updater.checks).toBe(1);
  });

  it('switching with Auto-Update on checks at once too, and the hourly check follows the channel', async () => {
    vi.useFakeTimers();
    const updater = fakeUpdater();
    const { updates } = updatesWith(updater);
    await updates.setAuto(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.checks).toBe(1);
    await updates.setChannel('alpha');
    expect(updater.checks).toBe(2);
    expect(updater.feeds.at(-1)).toEqual(genericFeed('alpha'));
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(updater.checks).toBe(3);
    expect(updater.feeds.at(-1)).toEqual(genericFeed('alpha'));
    updates.stop();
  });

  it('forgets what the other channel offered, and is remembered across launches', async () => {
    const updater = fakeUpdater({ version: '0.2.1-alpha.12' });
    const { updates } = updatesWith(updater);
    await updates.setChannel('alpha');
    expect(updates.state()).toMatchObject({ phase: 'available' });
    updater.next = { version: null };
    expect(await updates.setChannel('stable')).toMatchObject({
      channel: 'stable',
      phase: 'current',
      version: null,
    });
    expect(updater.channels).toEqual(['alpha', 'latest']);
    expect(updater.allowDowngrade).toBe(false);

    await writeFile(join(dir, 'updates.json'), '{"auto":false,"channel":"alpha"}\n');
    const next = fakeUpdater();
    const again = updatesWith(next).updates;
    expect((await again.current()).channel).toBe('alpha');
    await again.check();
    expect(next.feeds).toEqual([genericFeed('alpha')]);
    // Anything else in the file is Stable.
    await writeFile(join(dir, 'updates.json'), '{"channel":"beta"}\n');
    expect((await updatesWith(fakeUpdater()).updates.current()).channel).toBe('stable');
  });

  it('keeps a choice made while a build downloads for the next check', async () => {
    const updater = fakeUpdater({ version: '0.2.1' });
    const { updates } = updatesWith(updater);
    await updates.check();
    // Downloaded, and about to restart into it (the fake restart only counts).
    await updates.install();
    expect(updates.state().phase).toBe('ready');
    const checks = updater.checks;
    expect(await updates.setChannel('alpha')).toMatchObject({ channel: 'alpha', phase: 'ready' });
    expect(updater.checks).toBe(checks);
    expect(updater.feeds.at(-1)).toEqual(genericFeed('alpha'));
  });
});

describe("the channel in electron-updater's own updater (A1196)", () => {
  const cases: Array<[UpdateChannel, string, string]> = [
    ['stable', 'latest', 'https://github.com/htxryan/penmoss/releases/latest/download/'],
    ['alpha', 'alpha', 'https://github.com/htxryan/penmoss/releases/download/alpha/'],
  ];
  it.each(cases)('%s reads %s-*.yml at %s, with no token', async (channel, file, url) => {
    const updater = new RealUpdater('0.2.0', dir);
    point(updater, channel);
    const feed = await updater.feed();
    expect(feed.file.startsWith(`${file}-`)).toBe(true);
    expect(feed.url).toBe(url);
    expect(feed.headers ?? null).toBeNull();
    expect(updater.requestHeaders).toBeNull();
  });

  it('never offers an older build, even after the channel is set', async () => {
    // An Alpha build switched to Stable stays on its build until a stable release is newer.
    const alpha = new RealUpdater('0.2.1-alpha.12', dir);
    point(alpha, 'alpha');
    point(alpha, 'stable');
    expect(alpha.allowDowngrade).toBe(false);
    expect(await alpha.offers('0.2.0')).toBe(false);
    expect(await alpha.offers('0.2.1')).toBe(true);
    // Stable switched to Alpha takes the next build from main.
    const stable = new RealUpdater('0.2.0', dir);
    point(stable, 'alpha');
    expect(await stable.offers('0.2.1-alpha.13')).toBe(true);
    expect(await stable.offers('0.2.0-alpha.9')).toBe(false);
    // Today's 0.1.<run> builds move up to either.
    const old = new RealUpdater('0.1.440', dir);
    point(old, 'stable');
    expect(await old.offers('0.2.0')).toBe(true);
  });
});
