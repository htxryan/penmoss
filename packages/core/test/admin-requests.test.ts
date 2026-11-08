import { describe, expect, it } from 'vitest';
import { ADMIN_ACTIONS, ADMIN_ROUTES, adminActionOf } from '../src/admin-actions';
import {
  ADMIN_REQUESTS,
  adminCheckOf,
  adminHttpRequest,
  adminRequestOf,
  formatUserCode,
  isAdminRequestName,
  ownerCheckWords,
  pageMayAsk,
  returnsSecret,
  type AdminRequestName,
} from '../src/admin-requests';

// #85 (A541): the Mac app's page names an admin request; its main process checks the
// parameters and sends it with a token the page never sees.

const NOTE = '01JABCDEFGHJKMNPQRSTVWXYZ0';

/** One valid set of parameters for every request. */
const EXAMPLES: Record<AdminRequestName, Record<string, unknown>> = {
  listDevices: {},
  revokeDevice: { deviceId: '01JDEVICE0000000000000000A' },
  createToken: { label: 'Claude Code', scopes: ['write'], folderId: 'folder_1' },
  revokeToken: { tokenId: '01JTOKEN00000000000000000A' },
  revokeAll: { keepCurrent: true },
  recoveryCode: {},
  lookupSignIn: { userCode: 'ABCD-EFGH' },
  approveSignIn: { userCode: 'ABCD-EFGH', approve: true },
  denySignIn: { userCode: 'ABCD-EFGH', approve: false },
  approveAppSignIn: {
    redirectUri: 'http://127.0.0.1:53682/callback',
    codeChallenge: 'c'.repeat(43),
    codeChallengeMethod: 'S256',
    deviceKind: 'mac',
    label: 'Mac app',
  },
  backup: {},
  listBackups: {},
  listErrors: {},
  clearErrors: {},
  restoreNote: { noteId: NOTE, replace: true },
  restoreWorkspace: { name: 'workspace/2026-10-25.json' },
  reindex: { after: NOTE },
  rebuildIndex: { after: NOTE, vectors: '1' },
  searchIndex: {},
  purge: { noteId: NOTE },
  setMirrorTarget: {
    notebook: '01JNOTEBOOK000000000000000',
    repo: 'htxryan/qdk',
    branch: 'main',
    dir: 'docs/notes',
  },
  removeMirrorTarget: { notebook: '01JNOTEBOOK000000000000000' },
  confirmNotebook: { noteId: NOTE, notebook: '01JNOTEBOOK000000000000000', record: null },
};

const names = Object.keys(ADMIN_REQUESTS) as AdminRequestName[];

describe('admin requests by name (#85, A541)', () => {
  it('builds the request main sends, and the page’s call reads back as the same name', () => {
    for (const name of names) {
      const request = adminHttpRequest(name, EXAMPLES[name]);
      expect(request, name).not.toBeNull();
      expect(adminRequestOf(request!.method, request!.path, request!.body), name).toEqual({
        name,
        params: EXAMPLES[name],
      });
    }
    expect(adminHttpRequest('purge', { noteId: NOTE })).toEqual({
      method: 'DELETE',
      path: `/api/notes/${NOTE}`,
    });
    expect(adminHttpRequest('createToken', { scopes: ['read'] })).toEqual({
      method: 'POST',
      path: '/api/tokens',
      body: '{"scopes":["read"]}',
    });
    expect(adminHttpRequest('rebuildIndex', { vectors: '1' })?.path).toBe(
      '/api/admin/rebuild-index?vectors=1',
    );
  });

  it('asks the owner check exactly where adminActionOf does', () => {
    for (const name of names) {
      const request = adminHttpRequest(name, EXAMPLES[name])!;
      expect(adminActionOf(request.method, request.path, request.body), name).toBe(
        adminCheckOf(name),
      );
    }
    // Reads, and denying a CLI, ask nothing.
    expect(adminCheckOf('listDevices')).toBeNull();
    expect(adminCheckOf('denySignIn')).toBeNull();
    expect(adminCheckOf('approveSignIn')).toBe('approveSignIn');
  });

  it('covers every admin change core knows', () => {
    for (const [method, pattern, action] of ADMIN_ROUTES) {
      const covering = names.filter((name) => {
        const request = adminHttpRequest(name, EXAMPLES[name])!;
        return request.method === method && pattern.test(request.path.split('?')[0]!);
      });
      expect(covering.length, `${method} ${pattern}`).toBeGreaterThan(0);
      expect(covering.map(adminCheckOf), `${method} ${pattern}`).toContain(action);
    }
    for (const name of names) {
      const check = adminCheckOf(name);
      if (check) expect(Object.hasOwn(ADMIN_ACTIONS, check)).toBe(true);
    }
  });

  it('refuses unknown names, and parameters missing, extra or of the wrong shape', () => {
    expect(adminHttpRequest('deleteEverything', {})).toBeNull();
    expect(adminHttpRequest('__proto__', {})).toBeNull();
    expect(adminHttpRequest('toString', {})).toBeNull();
    expect(isAdminRequestName('constructor')).toBe(false);
    const refused: Array<[AdminRequestName, unknown]> = [
      ['purge', {}],
      ['purge', { noteId: '../devices/x' }],
      ['purge', { noteId: 'a/b' }],
      ['purge', { noteId: 'x'.repeat(81) }],
      ['purge', { noteId: 42 }],
      ['purge', { noteId: NOTE, method: 'GET' }],
      ['purge', { noteId: NOTE, path: '/api/devices' }],
      ['purge', 'noteId'],
      ['purge', [NOTE]],
      ['purge', null],
      ['revokeDevice', { deviceId: '' }],
      ['createToken', { scopes: ['admin'] }],
      ['createToken', { scopes: ['read', 'write', 'admin'] }],
      ['createToken', { scopes: [] }],
      ['createToken', { scopes: 'write' }],
      ['createToken', { label: 'x'.repeat(10_001), scopes: ['write'] }],
      ['lookupSignIn', { userCode: '' }],
      ['lookupSignIn', { userCode: 'ABCD–EFGH' }],
      ['createToken', { scopes: ['write'], folderId: '../x' }],
      ['revokeAll', { keepCurrent: 'yes' }],
      ['lookupSignIn', { userCode: 'ABCD/EFGH' }],
      ['approveSignIn', { userCode: 'ABCD-EFGH', approve: false }],
      ['approveSignIn', { userCode: 'ABCD-EFGH', approve: 'true' }],
      ['approveSignIn', { userCode: 'ABCD-EFGH' }],
      ['denySignIn', { userCode: 'ABCD-EFGH', approve: true }],
      ['approveAppSignIn', { ...EXAMPLES.approveAppSignIn, codeChallengeMethod: 'plain' }],
      ['approveAppSignIn', { ...EXAMPLES.approveAppSignIn, deviceKind: 'cli' }],
      ['restoreWorkspace', {}],
      ['reindex', { after: '?x=1' }],
      ['rebuildIndex', { vectors: '0' }],
      ['backup', { body: 'not json' }],
    ];
    for (const [name, params] of refused) {
      expect(adminHttpRequest(name, params), `${name} ${JSON.stringify(params)}`).toBeNull();
    }
    // An object that is not plain (a page cannot send one over IPC, but main never trusts that).
    expect(adminHttpRequest('purge', Object.create({ noteId: NOTE }))).toBeNull();
  });

  it('sends every call to an admin route to main, valid or not', () => {
    expect(adminRequestOf('GET', '/api/devices')).toEqual({ name: 'listDevices', params: {} });
    expect(adminRequestOf('delete', `/api/notes/${NOTE}`)).toEqual({
      name: 'purge',
      params: { noteId: NOTE },
    });
    expect(adminRequestOf('GET', '/api/auth/device/ABCD%20EFGH')).toEqual({
      name: 'lookupSignIn',
      params: { userCode: 'ABCD EFGH' },
    });
    expect(
      adminRequestOf('POST', '/api/auth/device/approve', '{"userCode":"ABCD","approve":false}'),
    ).toEqual({ name: 'denySignIn', params: { userCode: 'ABCD', approve: false } });
    // Read as given, for main to refuse.
    expect(adminRequestOf('POST', '/api/tokens', '{"scopes":["admin"]}')).toEqual({
      name: 'createToken',
      params: { scopes: ['admin'] },
    });
    expect(adminRequestOf('POST', '/api/auth/recovery-code', 'not json')).toEqual({
      name: 'recoveryCode',
      params: { body: 'not json' },
    });
    expect(adminHttpRequest('recoveryCode', { body: 'not json' })).toBeNull();
  });

  it('leaves alone what a read-write token may do', () => {
    for (const [method, path] of [
      ['GET', `/api/notes/${NOTE}/markdown`],
      ['DELETE', `/api/notes/${NOTE}/versions/v1`],
      ['POST', `/api/notes/${NOTE}/restore`],
      ['POST', '/api/errors'],
      ['DELETE', '/api/auth/token'],
      ['GET', '/api/me'],
      ['GET', '/api/trash'],
      ['POST', '/api/auth/page-token'],
      ['GET', '/api/devices/x'],
      ['DELETE', '/api/devices'],
      ['DELETE', '/api/notes/'],
      // Not the canonical path: the page sends it, and its token gets 403 (review N6).
      ['GET', '/api/devices/'],
      ['GET', '//api/devices'],
    ] as const) {
      expect(adminRequestOf(method, path), `${method} ${path}`).toBeNull();
    }
  });
});

// Review of PR #100.
describe('what the owner is asked, and what the Mac’s page may ask for', () => {
  it('words each change on its own, from checked parameters only', () => {
    const words = new Map<string, AdminRequestName>();
    for (const name of names) {
      const said = ownerCheckWords(name, EXAMPLES[name]);
      if (adminCheckOf(name) === null) {
        expect(said, name).toBeNull();
        continue;
      }
      // A mirror target names its repository (T43, A758): checked as owner/name.
      expect(said, name).toMatch(/^[a-z][a-z0-9 ’-]+(?:[A-Z0-9-]*|[a-z]+\/[a-z]+)$/);
      expect(words.get(said!), `${name} and ${words.get(said!)}`).toBeUndefined();
      words.set(said!, name);
    }
    // The page's own text never reaches the prompt.
    expect(ownerCheckWords('createToken', { label: 'sign out everything', scopes: ['read'] })).toBe(
      'create an agent token that can read your notes',
    );
    expect(ownerCheckWords('restoreWorkspace', { name: 'trust me', replace: true })).toBe(
      'replace your folders and notes with a backup',
    );
  });

  it('names the repository a notebook will be mirrored to (T43)', () => {
    expect(ownerCheckWords('setMirrorTarget', EXAMPLES.setMirrorTarget)).toBe(
      'mirror a notebook to htxryan/qdk',
    );
    expect(ownerCheckWords('setMirrorTarget', { notebook: 'default', repo: 'htxryan/notes' })).toBe(
      'mirror the default notebook to htxryan/notes',
    );
    expect(adminHttpRequest('setMirrorTarget', { notebook: 'x', repo: 'not a repo' })).toBeNull();
    expect(adminHttpRequest('setMirrorTarget', { notebook: '../x', repo: 'a/b' })).toBeNull();
  });

  it('confirms a held note’s notebook, by id only (T43, A769)', () => {
    expect(adminHttpRequest('confirmNotebook', EXAMPLES.confirmNotebook)).toEqual({
      method: 'POST',
      path: `/api/admin/notes/${NOTE}/notebook`,
      body: JSON.stringify({ notebook: '01JNOTEBOOK000000000000000', record: null }),
    });
    expect(ownerCheckWords('confirmNotebook', EXAMPLES.confirmNotebook)).toBe(
      'confirm a held note’s notebook so it is mirrored',
    );
    expect(
      ownerCheckWords('confirmNotebook', { noteId: NOTE, notebook: 'default', record: null }),
    ).toBe('confirm a held note is in the default notebook');
    // A record naming another notebook is said at the owner check (A769).
    expect(
      ownerCheckWords('confirmNotebook', { noteId: NOTE, notebook: 'default', record: 'work' }),
    ).toBe(
      'confirm a held note is in the default notebook although its own record names another notebook',
    );
    expect(
      ownerCheckWords('confirmNotebook', { noteId: NOTE, notebook: 'work', record: 'work' }),
    ).toBe('confirm a held note’s notebook so it is mirrored');
    expect(
      adminHttpRequest('confirmNotebook', { noteId: NOTE, notebook: '../x', record: null }),
    ).toBeNull();
    expect(adminHttpRequest('confirmNotebook', { noteId: NOTE, notebook: 'work' })).toBeNull();
    expect(adminHttpRequest('confirmNotebook', { noteId: NOTE })).toBeNull();
  });

  it('names a CLI’s code as its terminal shows it', () => {
    expect(ownerCheckWords('approveSignIn', { userCode: 'abcd efgh', approve: true })).toBe(
      'approve the sign-in ABCD-EFGH',
    );
    expect(formatUserCode('w0lf-1i0o')).toBe('W01F-1100');
  });

  it('accepts a CLI’s code however the server would (white space and hyphens dropped)', () => {
    for (const userCode of [
      'ABCD-EFGH',
      'abcd efgh',
      'ABCD\u00a0EFGH',
      'ABCD\tEFGH',
      ' abcdefgh ',
    ]) {
      expect(
        adminHttpRequest('approveSignIn', { userCode, approve: true }),
        userCode,
      ).not.toBeNull();
    }
    expect(
      adminHttpRequest('createToken', { label: 'x'.repeat(500), scopes: ['read'] }),
    ).not.toBeNull();
  });

  it('never sends an app’s sign-in approval for the Mac’s page (B1)', () => {
    expect(names.filter((name) => !pageMayAsk(name))).toEqual(['approveAppSignIn']);
  });
});

// Re-review of PR #100: a request whose answer is a code or a secret says so, and only these do.
describe('requests that answer with a secret', () => {
  it('are marked, and only the two Ryan is shown go to the Mac’s page', () => {
    expect(names.filter(returnsSecret)).toEqual([
      'createToken',
      'recoveryCode',
      'approveAppSignIn',
    ]);
    expect(names.filter((name) => returnsSecret(name) && pageMayAsk(name))).toEqual([
      'createToken',
      'recoveryCode',
    ]);
  });
});
