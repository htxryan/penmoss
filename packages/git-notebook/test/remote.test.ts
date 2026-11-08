/** Reading a git remote, and showing it without its credentials. */
import { describe, expect, it } from 'vitest';
import { redactRemote, remoteParts } from '../src/node/remote';

describe('remoteParts', () => {
  it('reads HTTPS, SSH and file remotes', () => {
    expect(remoteParts('https://github.com/acme/notes.git')).toEqual({
      host: 'github.com',
      path: 'acme/notes',
      protocol: 'https',
      credentials: false,
    });
    expect(remoteParts('git@github.com:acme/notes.git')).toEqual({
      host: 'github.com',
      path: 'acme/notes',
      protocol: 'ssh',
      credentials: false,
    });
    expect(remoteParts('ssh://git@GitHub.com/acme/notes')).toEqual({
      host: 'github.com',
      path: 'acme/notes',
      protocol: 'ssh',
      credentials: false,
    });
    expect(remoteParts('https://git.example.com/team/notes.git')?.host).toBe('git.example.com');
    expect(remoteParts('file:///srv/notes.git')).toEqual({
      host: '',
      path: '/srv/notes.git',
      protocol: 'file',
      credentials: false,
    });
    expect(remoteParts('ftp://example.com/x')).toBeNull();
    expect(remoteParts('not a remote')).toBeNull();
  });

  it('notices credentials in an HTTP URL, and never shows them', () => {
    expect(remoteParts('https://ghp_secret123@github.com/acme/notes.git')?.credentials).toBe(true);
    expect(remoteParts('https://me:pass@git.example.com/notes.git')?.credentials).toBe(true);
    expect(redactRemote('https://me:pass@git.example.com/notes.git')).toBe(
      'https://***@git.example.com/notes.git',
    );
    expect(redactRemote('git@github.com:acme/notes.git')).toBe('git@github.com:acme/notes.git');
  });
});
