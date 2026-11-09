import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  sandboxSpec,
  withDeveloperTools,
  withJavaHome,
  type SandboxPaths,
} from '../src/sandbox.ts';
import { testConfig } from './helpers.ts';

const config = testConfig();
const paths: SandboxPaths = {
  uid: 501,
  home: '/Users/r',
  realpath: (p) => p.replace('/opt/homebrew/opt/', '/opt/homebrew/Cellar/'),
};
const [slot1, slot2] = config.slots;
if (!slot1 || !slot2) throw new Error('two slots expected');

describe('sandboxSpec', () => {
  const spec = sandboxSpec(config, slot1, { GH_TOKEN: 'bot-token' }, paths);

  it('gives the slot its own ports and emulator', () => {
    expect(spec.env).toMatchObject({
      PENMOSS_PORT_BLOCK: '1',
      ANDROID_SERIAL: 'emulator-5560',
      ANDROID_ADB_SERVER_PORT: '5040',
      PENMOSS_AVD: 'penmoss37-slot1',
    });
    const other = sandboxSpec(config, slot2, {}, paths);
    expect(other.env['PENMOSS_PORT_BLOCK']).toBe('2');
    expect(other.env['ANDROID_SERIAL']).toBe('emulator-5562');
  });

  it('mounts the toolchains read-only at their real paths, and the factory-owned folders read-write', () => {
    const state = '/Users/r/Library/Application Support/penmoss-factory';
    expect(spec.mounts).toEqual(
      expect.arrayContaining([
        { hostPath: `${state}/pnpm-store`, sandboxPath: `${state}/pnpm-store`, readonly: false },
        { hostPath: `${state}/gradle`, sandboxPath: `${state}/gradle`, readonly: false },
        {
          hostPath: '/private/tmp/pnpm-dir-locks-501',
          sandboxPath: '/private/tmp/pnpm-dir-locks-501',
          readonly: false,
        },
        {
          hostPath: '/opt/homebrew/Cellar/openjdk@21',
          sandboxPath: '/opt/homebrew/Cellar/openjdk@21',
          readonly: true,
        },
        {
          hostPath: '/Users/r/Library/Android/sdk',
          sandboxPath: '/Users/r/Library/Android/sdk',
          readonly: true,
        },
      ]),
    );
    expect(spec.env['pnpm_config_store_dir']).toBe(`${state}/pnpm-store`);
    expect(spec.env['COREPACK_HOME']).toBe(`${state}/corepack`);
    expect(spec.env['JAVA_HOME']).toBe(
      '/opt/homebrew/Cellar/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    );
  });

  it("never mounts Ryan's own credentials or caches", () => {
    const paths = spec.mounts.map((m) => m.hostPath);
    for (const forbidden of [
      '/Users/r/.config',
      '/Users/r/.ssh',
      '/Users/r/Library/Keychains',
      '/Users/r/Library/pnpm',
      '/Users/r/.gradle',
      // The Mac's shared heavy-job slots: heavy.sh inside would free every host job's slot.
      '/Users/r/.cache',
    ]) {
      expect(paths.some((p) => p === forbidden || p.startsWith(`${forbidden}/`))).toBe(false);
    }
  });

  it('gives the slot a heavy-job folder of its own', () => {
    expect(spec.env['PENMOSS_HEAVY_DIR']).toMatch(/penmoss-factory\/heavy\/slot1$/);
    expect(spec.env['PENMOSS_HEAVY_SLOTS']).toBe('1');
    expect(spec.ownDirs).toContain(spec.env['PENMOSS_HEAVY_DIR']);
  });

  it('gives Claude Code a temp folder inside the sandbox', () => {
    const dir = spec.env['CLAUDE_CODE_TMPDIR'];
    expect(dir).toMatch(/penmoss-factory\/claude-tmp\/slot1$/);
    expect(spec.ownDirs).toContain(dir);
    expect(spec.mounts).toContainEqual({ hostPath: dir, sandboxPath: dir, readonly: false });
  });

  it('passes the scoped tokens and marks the run', () => {
    expect(spec.env['GH_TOKEN']).toBe('bot-token');
    expect(spec.env['PENMOSS_FACTORY_RUN']).toBe('1');
    expect(spec.env['GIT_CONFIG_NOSYSTEM']).toBe('1');
  });

  it("points Java's temp folder and home into the sandbox", () => {
    expect(withJavaHome('task android:test')).toBe(
      'export JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$TMPDIR -Duser.home=$HOME"; task android:test',
    );
  });
});

describe('withDeveloperTools', () => {
  it("puts the Command Line Tools' git ahead of the xcrun shim, once", () => {
    // A stand-in for xcode-select's link, so the test runs on any host (CI's Linux, A1235).
    const dir = mkdtempSync(join(tmpdir(), 'developer-tools-'));
    const tools = join(dir, 'CommandLineTools');
    mkdirSync(join(tools, 'usr', 'bin'), { recursive: true });
    writeFileSync(join(tools, 'usr', 'bin', 'git'), '');
    const link = join(dir, 'xcode_select_link');
    symlinkSync(tools, link);
    const bin = join(realpathSync(tools), 'usr', 'bin');
    const path = withDeveloperTools('/opt/homebrew/bin:/usr/bin:/bin', link);
    expect(path).toBe(`${bin}:/opt/homebrew/bin:/usr/bin:/bin`);
    expect(withDeveloperTools(path, link)).toBe(path);
  });
  it('leaves PATH alone without the tools', () => {
    expect(withDeveloperTools('/usr/bin', '/nonexistent/link')).toBe('/usr/bin');
  });
});
