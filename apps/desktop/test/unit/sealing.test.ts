import { describe, expect, it } from 'vitest';
import { encryptionUsable } from '../../src/sealing';

// What seals git notebooks' tokens and the GitHub token (A853, A1012): safeStorage, only where it
// really encrypts.

describe('sealing with safeStorage', () => {
  it('treats Linux’s basic_text backend as no encryption (only a test build may opt in)', () => {
    expect(encryptionUsable({ platform: 'darwin', available: true, backend: 'unknown' })).toBe(
      true,
    );
    expect(encryptionUsable({ platform: 'darwin', available: false, backend: 'unknown' })).toBe(
      false,
    );
    expect(
      encryptionUsable({ platform: 'linux', available: true, backend: 'gnome_libsecret' }),
    ).toBe(true);
    expect(encryptionUsable({ platform: 'linux', available: true, backend: 'basic_text' })).toBe(
      false,
    );
    expect(
      encryptionUsable({
        platform: 'linux',
        available: true,
        backend: 'basic_text',
        allowBasicText: true,
      }),
    ).toBe(true);
  });
});
