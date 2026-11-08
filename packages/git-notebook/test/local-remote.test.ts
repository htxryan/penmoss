import { describe, expect, it } from 'vitest';
import { isLocalRemote } from '../src/transport';

describe('a remote on this device (#174 review, F9; delta review)', () => {
  it('a path, file:// and the loopback are local', () => {
    for (const remote of [
      '/Users/ryan/notes.git',
      'file:///Users/ryan/notes.git',
      'http://127.0.0.1:8787/notes.git',
      'https://localhost/notes.git',
      'ssh://git@[::1]:2222/notes.git',
      'git@localhost:notes.git',
      'localhost:notes.git',
    ]) {
      expect(isLocalRemote(remote), remote).toBe(true);
    }
  });

  it('a host that only names the loopback in its fragment, query or user is not', () => {
    for (const remote of [
      'https://evil.com#@127.0.0.1/x',
      'https://evil.com/x#@127.0.0.1/x',
      'https://evil.com?a@localhost/x',
      'https://evil.com/x?a@localhost',
      'https://127.0.0.1.evil.com/x',
      'https://localhost@evil.com/x',
      '?a@localhost:notes.git',
      'git@github.com:htxryan/notes.git',
      'https://github.com/htxryan/notes.git',
      'not a remote',
    ]) {
      expect(isLocalRemote(remote), remote).toBe(false);
    }
  });
});
