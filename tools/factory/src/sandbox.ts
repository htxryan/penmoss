/**
 * What one slot's sandbox sees (F17, #262): Sandcastle's Seatbelt provider (FD22) with the
 * Android SDK, the JDK and Playwright's browsers mounted read-only, the factory's own pnpm store,
 * Gradle home and AVDs read-write, pnpm 12's fixed lock folders, the slot's ports and emulator,
 * and the scoped tokens from the env file. Nothing from Ryan's home: no ~/.config/gh, no
 * ~/.ssh, no keychain, no pnpm store or Gradle home of his.
 *
 * The profile itself is Sandcastle's, plus two rules carried as a pnpm patch
 * (tools/factory/patches): Chromium's Mach rendezvous service and the hw.* / machdep.cpu.*
 * sysctls the emulator reads.
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig, type SlotConfig } from './config.ts';
import type { Secrets } from './secrets.ts';

export interface Mount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly?: boolean;
}

export interface SandboxSpec {
  readonly env: Readonly<Record<string, string>>;
  readonly mounts: readonly Mount[];
  /** Folders the factory owns, made before the sandbox starts. */
  readonly ownDirs: readonly string[];
}

/** pnpm 12 keeps these lock folders at fixed paths in /tmp, outside the sandbox's own temp. */
export const PNPM_LOCK_DIRS = [
  'dir-locks',
  'modules-swaps',
  'store-operation-locks',
  'verify-deps-install-locks',
] as const;

export interface SandboxPaths {
  readonly uid: number;
  readonly home: string;
  /** Resolves symlinks (Homebrew's opt/ links), since a mount must be the real path. */
  readonly realpath: (path: string) => string;
}

export const hostPaths = (): SandboxPaths => ({
  uid: process.getuid?.() ?? 501,
  home: process.env['HOME'] ?? '',
  realpath: (path) => realpathSync(path),
});

/** The slot's sandbox, as data; `seatbeltProvider` turns it into Sandcastle's provider. */
export function sandboxSpec(
  config: FactoryConfig,
  slot: SlotConfig,
  /** factory.env's tokens, plus the run's read-only `GH_TOKEN` (A1222). */
  secrets: Secrets & { readonly GH_TOKEN?: string },
  paths: SandboxPaths = hostPaths(),
): SandboxSpec {
  const state = expandHome(config.stateDir, paths.home);
  const own = {
    pnpmStore: join(state, 'pnpm-store'),
    gradle: join(state, 'gradle'),
    avd: join(state, 'avd'),
    corepack: join(state, 'corepack'),
    // This slot's own heavy-job folder: the Mac's shared one stays outside (see heavy.ts).
    heavy: join(state, 'heavy', `slot${slot.id}`),
  };
  const jdk = paths.realpath(expandHome(config.toolchain.jdk, paths.home));
  const sdk = paths.realpath(expandHome(config.toolchain.androidSdk, paths.home));
  const browsers = paths.realpath(expandHome(config.toolchain.playwrightBrowsers, paths.home));
  const pnpmLocks = PNPM_LOCK_DIRS.map((name) => `/private/tmp/pnpm-${name}-${paths.uid}`);
  const at = (hostPath: string, readonly = false): Mount => ({
    hostPath,
    sandboxPath: hostPath,
    readonly,
  });

  const env: Record<string, string> = {
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    // pnpm 12 reads pnpm_config_*, not npm_config_*.
    pnpm_config_store_dir: own.pnpmStore,
    // Corepack's pnpm download, kept between runs instead of fetched into each private home.
    COREPACK_HOME: own.corepack,
    GRADLE_USER_HOME: own.gradle,
    JAVA_HOME: join(jdk, 'libexec/openjdk.jdk/Contents/Home'),
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    ANDROID_AVD_HOME: own.avd,
    ANDROID_ADB_SERVER_PORT: String(slot.adbServerPort),
    ANDROID_SERIAL: `emulator-${slot.emulatorPort}`,
    PENMOSS_AVD: slot.avd,
    PENMOSS_EMULATOR_PORT: String(slot.emulatorPort),
    PLAYWRIGHT_BROWSERS_PATH: browsers,
    PENMOSS_PORT_BLOCK: String(slot.portBlock),
    // Kotlin's daemon and JGit use Java's temp folder and home, not $TMPDIR and $HOME: the
    // sandbox's own, which Sandcastle sets, are spelled out per command (see `withJavaHome`).
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // Lets repo tasks refuse what a run must never do (production deploys, FD24).
    PENMOSS_FACTORY_RUN: '1',
    PENMOSS_HEAVY_DIR: own.heavy,
    PENMOSS_HEAVY_SLOTS: '1',
  };
  for (const [key, value] of Object.entries(secrets)) if (value) env[key] = value;

  return {
    env,
    mounts: [
      at(own.pnpmStore),
      at(own.gradle),
      at(own.avd),
      at(own.corepack),
      at(own.heavy),
      ...pnpmLocks.map((dir) => at(dir)),
      at(jdk, true),
      at(sdk, true),
      at(browsers, true),
    ],
    ownDirs: [own.pnpmStore, own.gradle, own.avd, own.corepack, own.heavy, ...pnpmLocks],
  };
}

/**
 * A command with Java's temp folder and home pointed into the sandbox, as Gradle needs (Kotlin
 * already compiles in-process: apps/android/gradle.properties).
 */
export function withJavaHome(command: string): string {
  return `export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$TMPDIR -Duser.home=$HOME"; ${command}`;
}

/** Makes the folders the factory owns (mode 700). */
export function makeOwnDirs(spec: SandboxSpec): void {
  for (const dir of spec.ownDirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Sandcastle builds a sandbox's PATH from this process's. `/usr/bin/git` is Apple's xcrun shim,
 * which can't write its cache in the user's temp folder under Seatbelt and says so on stderr,
 * which corrupts tests that read git's output (#262). The Command Line Tools' own binaries
 * go first instead.
 */
export function withDeveloperTools(path: string, link = '/var/db/xcode_select_link'): string {
  let bin: string;
  try {
    bin = join(realpathSync(link), 'usr/bin');
  } catch {
    return path;
  }
  if (!existsSync(join(bin, 'git'))) return path;
  const rest = path.split(':').filter((p) => p && p !== bin);
  return [bin, ...rest].join(':');
}

/** Sandcastle's Seatbelt provider for a spec. Imported lazily: it checks Seatbelt on load. */
export async function seatbeltProvider(spec: SandboxSpec) {
  process.env['PATH'] = withDeveloperTools(process.env['PATH'] ?? '/usr/bin:/bin');
  const { seatbelt } = await import('@ai-hero/sandcastle/sandboxes/seatbelt');
  return seatbelt({ env: { ...spec.env }, mounts: spec.mounts });
}
