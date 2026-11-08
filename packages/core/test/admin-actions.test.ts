import { describe, expect, it } from 'vitest';
import { ADMIN_ACTIONS, adminActionOf, isAdminAction } from '../src/admin-actions';

describe('admin actions (T41, A503)', () => {
  it('names every admin change a client sends', () => {
    expect(adminActionOf('DELETE', '/api/notes/01JABCDEFGHJKMNPQRSTVWXYZ0')).toBe('purge');
    expect(adminActionOf('delete', '/api/devices/dev_1')).toBe('revokeDevice');
    expect(adminActionOf('POST', '/api/tokens')).toBe('createToken');
    expect(adminActionOf('DELETE', '/api/tokens/tok_1')).toBe('revokeToken');
    expect(adminActionOf('POST', '/api/auth/revoke-all')).toBe('revokeAll');
    expect(adminActionOf('POST', '/api/auth/recovery-code')).toBe('recoveryCode');
    expect(adminActionOf('POST', '/api/auth/device/approve')).toBe('approveSignIn');
    expect(adminActionOf('POST', '/api/auth/native/code')).toBe('approveSignIn');
    expect(adminActionOf('POST', '/api/admin/backup')).toBe('backup');
    expect(adminActionOf('DELETE', '/api/errors')).toBe('clearErrors');
    expect(adminActionOf('POST', '/api/admin/restore/notes/n1')).toBe('restore');
    expect(adminActionOf('POST', '/api/admin/rebuild-index?after=x&vectors=1')).toBe('reindex');
    expect(adminActionOf('POST', '/api/admin/reindex')).toBe('reindex');
    expect(adminActionOf('PUT', '/api/admin/mirror/targets/nb1')).toBe('mirrorTarget');
    expect(adminActionOf('DELETE', '/api/admin/mirror/targets/default')).toBe('mirrorTarget');
    expect(adminActionOf('POST', '/api/admin/notes/n1/notebook')).toBe('confirmNotebook');
  });

  it('leaves reads and read-write changes alone', () => {
    expect(adminActionOf('GET', '/api/devices')).toBeNull();
    expect(adminActionOf('GET', '/api/errors')).toBeNull();
    expect(adminActionOf('GET', '/api/admin/backups')).toBeNull();
    expect(adminActionOf('POST', '/api/errors')).toBeNull();
    expect(adminActionOf('DELETE', '/api/auth/token')).toBeNull();
    expect(adminActionOf('POST', '/api/notes/n1/restore')).toBeNull();
    expect(adminActionOf('DELETE', '/api/notes/n1/versions/v1')).toBeNull();
    expect(adminActionOf('POST', '/api/notes')).toBeNull();
    expect(adminActionOf('GET', '/api/mirror')).toBeNull();
  });

  it('does not check denying a CLI’s sign-in, and checks anything else sent there', () => {
    const approve = '/api/auth/device/approve';
    expect(adminActionOf('POST', approve, '{"userCode":"ABCD-EFGH","approve":false}')).toBeNull();
    for (const body of [
      '{"userCode":"ABCD-EFGH","approve":true}',
      '{"userCode":"ABCD-EFGH","approve":"false"}',
      '{"userCode":"ABCD-EFGH"}',
      'not json',
      undefined,
      null,
    ]) {
      expect(adminActionOf('POST', approve, body)).toBe('approveSignIn');
    }
    // Only that route: a denial-shaped body elsewhere changes nothing.
    expect(adminActionOf('POST', '/api/auth/native/code', '{"approve":false}')).toBe(
      'approveSignIn',
    );
  });

  it('treats any other change under /api/admin/ as an admin change', () => {
    expect(adminActionOf('POST', '/api/admin/something-new')).toBe('admin');
    expect(adminActionOf('PUT', '/api/admin/x')).toBe('admin');
  });

  it('knows only its own ids, with words that follow “is trying to”', () => {
    expect(isAdminAction('purge')).toBe(true);
    expect(isAdminAction('toString')).toBe(false);
    expect(isAdminAction('__proto__')).toBe(false);
    expect(isAdminAction(42)).toBe(false);
    for (const words of Object.values(ADMIN_ACTIONS)) {
      expect(words).toMatch(/^[a-z][a-z -]+[a-z]$/);
    }
  });
});
