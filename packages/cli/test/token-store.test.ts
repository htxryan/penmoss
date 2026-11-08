import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeTokenStore, toolMessage } from '../src/token-store';

// Git notebooks' secrets (T50): a notebook's token and its writer secret, each under its own key.
const API = 'token:01JB8Y0V5TQ0QW8KZ9C7N3F2XA';
const LOCAL = 'writer:01JB8Y0V5TQ0QW8KZ9C7N3F2XA';
const TOKEN = 'ghp_' + 'A'.repeat(36);
const OTHER = 'ghp_' + 'B'.repeat(36);

let root: string;
let home: string;
let bin: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'penmoss-cli-'));
  home = join(root, 'home');
  bin = join(root, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const mode = async (path: string) => (await lstat(path)).mode & 0o777;
const configPath = () => join(home, '.penmoss', 'credentials.json');

function store(platform: NodeJS.Platform = 'linux', extra: Record<string, string> = {}) {
  return nodeTokenStore({
    platform,
    env: { PATH: bin, FAKE_DIR: root, ...extra },
    service: 'penmoss-git',
    file: configPath(),
    accepts: (secret) => /^[A-Za-z0-9_.~+/=-]{8,1000}$/.test(secret),
  });
}

/** A fake keychain tool: it keeps one secret in $FAKE_DIR/secret and logs its arguments. */
async function fakeTool(name: string, script: string) {
  const path = join(bin, name);
  // The store runs it with PATH set to the fake bin directory alone.
  const header = '#!/bin/sh\nPATH=/usr/bin:/bin\necho "$@" >> "$FAKE_DIR/argv.log"';
  await writeFile(path, `${header}\n${script}\n`);
  await chmod(path, 0o755);
}

const SECRET_TOOL = `case "$1" in
  store) cat > "$FAKE_DIR/secret" ;;
  lookup) if [ -f "$FAKE_DIR/secret" ]; then cat "$FAKE_DIR/secret"; else exit 1; fi ;;
  clear) rm -f "$FAKE_DIR/secret" ;;
esac`;

const SECURITY = `case "$1" in
  -i) while read -r line; do
        case "$line" in add-generic-password*)
          printf '%s' "$line" | sed -E 's/.*-w "([^"]*)".*/\\1/' > "$FAKE_DIR/secret" ;;
        esac
      done ;;
  find-generic-password) if [ -f "$FAKE_DIR/secret" ]; then cat "$FAKE_DIR/secret"; echo; else exit 44; fi ;;
  delete-generic-password) if [ -f "$FAKE_DIR/secret" ]; then rm -f "$FAKE_DIR/secret"; else exit 44; fi ;;
esac`;

describe('the credentials file (headless machines)', () => {
  it('is the fallback without a keychain, created 0600 in a 0700 directory', async () => {
    const tokens = store();
    expect(tokens.describe()).toEqual({ keychain: null, file: configPath() });
    expect(await tokens.get(API)).toBeNull();

    expect(await tokens.set(API, TOKEN, 'auto')).toEqual({ location: 'file' });
    expect(await mode(configPath())).toBe(0o600);
    expect(await mode(join(home, '.penmoss'))).toBe(0o700);
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({
      tokens: { [API]: TOKEN },
    });
    expect(await tokens.get(API)).toEqual({ token: TOKEN, location: 'file' });

    // One token per API origin; deleting one keeps the other.
    await tokens.set(LOCAL, OTHER, 'file');
    expect(await tokens.get(LOCAL)).toEqual({ token: OTHER, location: 'file' });
    expect(await tokens.delete(API)).toEqual(['file']);
    expect(await tokens.get(API)).toBeNull();
    expect(await tokens.get(LOCAL)).toEqual({ token: OTHER, location: 'file' });
    expect(await mode(configPath())).toBe(0o600);
  });

  it('refuses to read a file other users can read, and says how to fix it', async () => {
    const tokens = store();
    await tokens.set(API, TOKEN, 'file');
    await chmod(configPath(), 0o644);
    await expect(tokens.get(API)).rejects.toThrow(/readable by other users.*chmod 600/s);
    await chmod(configPath(), 0o600);
    expect(await tokens.get(API)).toEqual({ token: TOKEN, location: 'file' });
  });

  it('refuses a symlinked credentials file', async () => {
    await mkdir(join(home, '.penmoss'), { recursive: true, mode: 0o700 });
    const target = join(root, 'elsewhere.json');
    await writeFile(target, JSON.stringify({ tokens: { [API]: TOKEN } }), { mode: 0o600 });
    await symlink(target, configPath());
    await expect(store().get(API)).rejects.toThrow(/not a regular file/);
  });

  it('never changes the mode of a directory the credentials directory links to', async () => {
    const target = join(root, 'shared');
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
    await symlink(target, join(home, '.penmoss'));
    await store().set(API, TOKEN, 'file');
    expect(await mode(target)).toBe(0o755);
    expect(await mode(join(target, 'credentials.json'))).toBe(0o600);
  });

  it('refuses a FIFO at once instead of waiting on it', async () => {
    await mkdir(join(home, '.penmoss'), { recursive: true, mode: 0o700 });
    execFileSync('mkfifo', ['-m', '600', configPath()]);
    const started = Date.now();
    await expect(store().get(API)).rejects.toThrow(/not a regular file/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('refuses a token with characters a token never has', async () => {
    await expect(store().set(API, 'ghp_"; rm -rf ~', 'file')).rejects.toThrow(/token/);
  });
});

describe('libsecret (secret-tool on Linux)', () => {
  it('stores the token through stdin, never on the command line', async () => {
    await fakeTool('secret-tool', SECRET_TOOL);
    const tokens = store();
    expect(tokens.describe().keychain).toBe('the Secret Service keyring');
    expect(await tokens.set(API, TOKEN, 'auto')).toEqual({ location: 'keychain' });
    expect(await readFile(join(root, 'secret'), 'utf8')).toBe(TOKEN);
    expect(await tokens.get(API)).toEqual({ token: TOKEN, location: 'keychain' });
    const argv = await readFile(join(root, 'argv.log'), 'utf8');
    expect(argv).toContain(`store --label=Penmoss CLI (${API}) service penmoss-git account ${API}`);
    expect(argv).not.toContain(TOKEN);
    // No credentials file was written.
    await expect(lstat(configPath())).rejects.toThrow();
    expect(await tokens.delete(API)).toEqual(['keychain']);
    expect(await tokens.get(API)).toBeNull();
  });

  it('falls back to the credentials file when the keyring is unreachable (no D-Bus session)', async () => {
    await fakeTool(
      'secret-tool',
      'echo "Cannot autolaunch D-Bus without X11 $DISPLAY" >&2\nexit 1',
    );
    const tokens = store();
    const stored = await tokens.set(API, TOKEN, 'auto');
    expect(stored.location).toBe('file');
    expect(stored.note).toMatch(/keyring/);
    expect(await tokens.get(API)).toEqual({ token: TOKEN, location: 'file' });
    // Asking for the keychain explicitly fails instead.
    await expect(tokens.set(API, TOKEN, 'keychain')).rejects.toThrow(/keyring/);
  });
});

describe('keychain tools that misbehave (A169, A171)', () => {
  it('reads a token in the credentials file without asking the keychain', async () => {
    await store().set(API, TOKEN, 'file');
    await fakeTool('secret-tool', SECRET_TOOL);
    expect(await store().get(API)).toEqual({ token: TOKEN, location: 'file' });
    await expect(readFile(join(root, 'argv.log'), 'utf8')).rejects.toThrow();
  });

  it('gives up on a lookup after about 2 s, and does not ask again in the same run', async () => {
    await fakeTool('secret-tool', 'sleep 30');
    const tokens = store();
    let started = Date.now();
    expect(await tokens.get(API)).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_500);
    started = Date.now();
    expect(await tokens.get(LOCAL)).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  }, 15_000);

  it('prints a tool’s failure without the token or terminal escapes', async () => {
    await fakeTool(
      'secret-tool',
      `printf '\\033[31mcannot store %s\\033[0m\\n second line' "$(cat)" >&2\nexit 1`,
    );
    await expect(store().set(API, TOKEN, 'keychain')).rejects.toThrow(
      /^Could not save to the Secret Service keyring: cannot store \[token\]$/,
    );
    expect(
      toolMessage({ code: 1, stdout: '', stderr: `\u0007bad pms_${'x'.repeat(30)}\n` }, 'security'),
    ).toBe('bad [token]');
    expect(toolMessage({ code: 3, stdout: '', stderr: '' }, 'security')).toBe('security exited 3');
  });
});

describe('the macOS keychain (security)', () => {
  it('stores through `security -i` on stdin, never on the command line', async () => {
    await fakeTool('security', SECURITY);
    const tokens = store('darwin');
    expect(tokens.describe().keychain).toBe('the macOS keychain');
    expect(await tokens.set(API, TOKEN, 'auto')).toEqual({ location: 'keychain' });
    expect(await tokens.get(API)).toEqual({ token: TOKEN, location: 'keychain' });
    const argv = await readFile(join(root, 'argv.log'), 'utf8');
    expect(argv).not.toContain(TOKEN);
    expect(argv).toContain(`find-generic-password -s penmoss-git -a ${API} -w`);
    expect(await tokens.delete(API)).toEqual(['keychain']);
    expect(await tokens.get(API)).toBeNull();
  });

  it('moves a token out of the credentials file when it is saved to the keychain', async () => {
    await store('darwin').set(API, OTHER, 'file');
    await fakeTool('security', SECURITY);
    const tokens = store('darwin');
    expect(await tokens.set(API, TOKEN, 'auto')).toEqual({ location: 'keychain' });
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({ tokens: {} });
  });

  it('uses the credentials file when asked to', async () => {
    await fakeTool('security', SECURITY);
    const tokens = store('darwin');
    expect(await tokens.set(API, TOKEN, 'file')).toEqual({ location: 'file' });
    expect(await tokens.get(API)).toEqual({ token: TOKEN, location: 'file' });
  });
});
