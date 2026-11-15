/**
 * An SSH remote's host as SSH resolves it (A1565): `ssh -G <host>` prints the configuration it
 * would use, `hostname` among it. A fake `ssh -G` here: no ssh runs, and no config is read.
 */
import { describe, expect, it } from 'vitest';
import type { BoundedResult } from '../../src/bounded-exec';
import { sshHostName, sshHostResolver, type RunSsh } from '../../src/ssh-host';

/** What `ssh -G github-quanta` prints with `Host github-quanta` / `HostName github.com`. */
const QUANTA = [
  'host github-quanta',
  'user git',
  'hostname github.com',
  'port 22',
  'identityfile ~/.ssh/id_quanta',
  'addressfamily any',
  '',
].join('\n');

const exit = (stdout: string, code = 0): BoundedResult => ({
  kind: 'exit',
  code,
  stdout,
  stderr: '',
});

function fakeSsh(answers: Record<string, BoundedResult>) {
  const calls: (readonly string[])[] = [];
  const run: RunSsh = (args) => {
    calls.push(args);
    const answer = answers[args[1] ?? ''];
    return answer ? Promise.resolve(answer) : Promise.reject(new Error('no ssh'));
  };
  return { run, calls };
}

describe('sshHostName', () => {
  it('reads the hostname line of ssh -G', () => {
    expect(sshHostName(QUANTA)).toBe('github.com');
    expect(sshHostName('user git\nHostName  GitHub.com  \n')).toBe('github.com');
  });

  it('is null with no hostname line, or one that is not a host', () => {
    expect(sshHostName('user git\nport 22\n')).toBeNull();
    expect(sshHostName('hostname -oProxyCommand=x\n')).toBeNull();
    expect(sshHostName('')).toBeNull();
  });
});

describe('sshHostResolver', () => {
  it('resolves an alias to its HostName, asking ssh -G once a host', async () => {
    const ssh = fakeSsh({
      'github-quanta': exit(QUANTA),
      'github.com': exit('host github.com\nhostname github.com\n'),
    });
    const resolve = sshHostResolver(ssh.run);
    expect(await resolve('github-quanta')).toBe('github.com');
    expect(await resolve('GitHub-Quanta')).toBe('github.com');
    expect(await resolve('github.com')).toBe('github.com');
    expect(ssh.calls).toEqual([
      ['-G', 'github-quanta'],
      ['-G', 'github.com'],
    ]);
  });

  it('keeps the host when ssh fails, says nothing, or is out of time', async () => {
    const ssh = fakeSsh({
      failed: exit('', 255),
      quiet: exit('user git\n'),
      slow: { kind: 'timeout', stdout: '', stderr: '' },
    });
    const resolve = sshHostResolver(ssh.run);
    expect(await resolve('failed')).toBe('failed');
    expect(await resolve('quiet')).toBe('quiet');
    expect(await resolve('slow')).toBe('slow');
    // No ssh at all.
    expect(await resolve('missing')).toBe('missing');
  });

  it('never asks about a host ssh would read as an option', async () => {
    const ssh = fakeSsh({});
    const resolve = sshHostResolver(ssh.run);
    expect(await resolve('-oProxyCommand=touch')).toBe('-oproxycommand=touch');
    expect(await resolve('a b')).toBe('a b');
    expect(ssh.calls).toEqual([]);
  });
});
