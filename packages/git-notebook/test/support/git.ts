/**
 * Real git for the transport's tests (T50 G2): temporary bare repositories (`file://`, with
 * filters allowed, as #150's verification says), a host over HTTP (`git http-backend` behind a
 * Node server with Basic auth), and a colleague who commits with plain git. No network: every
 * host is on this machine. git's own configuration is shut out (`GIT_CONFIG_GLOBAL=/dev/null`,
 * `GIT_CONFIG_NOSYSTEM=1`), so the runner's settings never leak in.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ISOLATED = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_DATE: undefined,
  GIT_COMMITTER_DATE: undefined,
} as const;

const env = () => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
});

/** Runs git synchronously (setup only), failing the test on a non-zero exit. */
export function git(cwd: string, args: readonly string[], input?: string): string {
  const result = spawnSync('git', args, { cwd, env: env(), input, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export interface Sandbox {
  readonly dir: string;
  /** A new empty bare repository at `<dir>/<name>.git` with `main` as its default branch. */
  bare(name: string): { path: string; url: string };
  /** A colleague's working clone, to commit code next to the notebook. */
  colleague(url: string, name?: string): Colleague;
  cleanup(): void;
}

export interface Colleague {
  readonly path: string;
  /** Writes files (null removes one), commits and pushes to `branch`. */
  commit(files: Record<string, string | null>, message?: string, branch?: string): string;
  /** Pulls `branch` and reads a file. */
  read(path: string, branch?: string): string | null;
  /** Every path in `branch`'s head. */
  files(branch?: string): string[];
  log(branch?: string): string[];
}

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'penmoss-git-'));
  let colleagues = 0;
  return {
    dir,
    bare(name) {
      const path = join(dir, `${name}.git`);
      mkdirSync(path, { recursive: true });
      git(path, ['init', '--bare', '--quiet', '--initial-branch=main']);
      git(path, ['config', 'uploadpack.allowFilter', 'true']);
      git(path, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
      git(path, ['config', 'http.receivepack', 'true']);
      return { path, url: `file://${path}` };
    },
    colleague(url, name = 'A Colleague') {
      const path = join(dir, `colleague-${++colleagues}`);
      mkdirSync(path);
      git(path, ['init', '--quiet', '--initial-branch=main']);
      git(path, ['remote', 'add', 'origin', url]);
      git(path, ['config', 'user.name', name]);
      git(path, ['config', 'user.email', 'colleague@example.invalid']);
      const sync = (branch: string) => {
        const has = spawnSync('git', ['ls-remote', '--exit-code', 'origin', branch], {
          cwd: path,
          env: env(),
        });
        if (has.status === 0) {
          git(path, ['fetch', '--quiet', 'origin', branch]);
          git(path, ['checkout', '--quiet', '-B', branch, `origin/${branch}`]);
          return true;
        }
        git(path, ['checkout', '--quiet', '--orphan', branch]);
        spawnSync('git', ['rm', '-rfq', '--cached', '.'], { cwd: path, env: env() });
        return false;
      };
      return {
        path,
        commit(files, message = 'Code change', branch = 'main') {
          sync(branch);
          for (const [file, text] of Object.entries(files)) {
            const full = join(path, file);
            if (text === null) {
              rmSync(full, { force: true });
              continue;
            }
            mkdirSync(join(full, '..'), { recursive: true });
            writeFileSync(full, text);
          }
          git(path, ['add', '-A']);
          git(path, ['commit', '--quiet', '--allow-empty', '-m', message]);
          git(path, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
          return git(path, ['rev-parse', 'HEAD']);
        },
        read(file, branch = 'main') {
          if (!sync(branch)) return null;
          const result = spawnSync('git', ['show', `HEAD:${file}`], {
            cwd: path,
            env: env(),
            encoding: 'utf8',
          });
          return result.status === 0 ? result.stdout : null;
        },
        files(branch = 'main') {
          if (!sync(branch)) return [];
          return git(path, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
        },
        log(branch = 'main') {
          if (!sync(branch)) return [];
          return git(path, ['log', '--format=%an|%s']).split('\n').filter(Boolean);
        },
      };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Makes a bare repository refuse every push with `message`, as a host's hook would. */
export function refusePushes(bare: string, message: string): void {
  const hook = join(bare, 'hooks', 'pre-receive');
  mkdirSync(join(bare, 'hooks'), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\necho "${message}" >&2\nexit 1\n`, { mode: 0o755 });
}

export function allowPushes(bare: string): void {
  rmSync(join(bare, 'hooks', 'pre-receive'), { force: true });
}

/**
 * A git host over HTTP: `git http-backend` (smart HTTP) serving `root`'s repositories behind
 * Basic auth (`user`/`password`; null: none), on 127.0.0.1. Only the protocol a real host speaks.
 */
export async function httpHost(
  root: string,
  credentials: { readonly user: string; readonly password: string } | null,
): Promise<{ readonly origin: string; readonly requests: string[]; close(): Promise<void> }> {
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
  const backend = join(exec, 'git-http-backend');
  const requests: string[] = [];
  const expected = credentials
    ? `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`
    : null;
  const server: Server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (expected !== null && request.headers.authorization !== expected) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="penmoss-test"' });
      response.end('Unauthorized');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    const child = spawn(backend, [], {
      env: {
        ...env(),
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REMOTE_USER: credentials?.user ?? 'anonymous',
        REQUEST_METHOD: request.method ?? 'GET',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
        GIT_PROTOCOL: (request.headers['git-protocol'] as string | undefined) ?? '',
      },
    });
    request.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let headerDone = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (headerDone) {
        response.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      headerDone = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
        const colon = line.indexOf(':');
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
        else headers[key] = value;
      }
      response.writeHead(status, headers);
      response.write(head.subarray(end + 4));
    });
    child.stdout.on('end', () => response.end());
    child.stderr.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
