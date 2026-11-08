/**
 * Admin requests by name (#85, A541). The Mac app's page holds a read-write
 * token only; its main process holds the admin token and sends every request
 * that needs it. The page names the request and its parameters; main checks
 * them here, runs the owner check for a change (`check`, an `ADMIN_ACTIONS`
 * id; A504), and builds the HTTP request itself, so a page can reach no admin
 * route except through these names, with parameters of these shapes.
 *
 * - `adminRequestOf(method, path, body)`: the page side. Which admin request
 *   a page's API call is, so `SessionManager.api` hands it to main instead of
 *   sending it. Parameters are read as they are, unchecked: main checks them.
 * - `adminHttpRequest(name, params)`: the main side. The request to send, or
 *   null when the name is unknown or a parameter is missing, extra or of the
 *   wrong shape.
 *
 * Every route behind the server's `requireAdmin` has an entry (the server's
 * test fails otherwise), reads included: a read-write token cannot list
 * devices either. One is never sent for the Mac's page (`pageMayAsk`):
 * approving an app's sign-in, whose code the page could redeem itself with
 * its own PKCE verifier (review of PR #100, B1).
 *
 * `ownerCheckWords` says what each change is for in the owner check's
 * prompt, from checked parameters only, never from text the page wrote.
 */
import { ADMIN_ACTIONS, type AdminAction } from './admin-actions';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Valid = (value: unknown) => boolean;

/** A request main sends with the admin token. `body` is JSON. */
export interface AdminHttpRequest {
  readonly method: Method;
  readonly path: string;
  readonly body?: string;
}

/** What a page asks main for: a name from `ADMIN_REQUESTS` and its parameters. */
export interface AdminRequest {
  readonly name: AdminRequestName;
  readonly params: Readonly<Record<string, unknown>>;
}

interface Field {
  readonly valid: Valid;
  readonly optional?: boolean;
}

interface Spec {
  /** The owner check before it (A504); null for a read, or a denial, which changes nothing. */
  readonly check: AdminAction | null;
  readonly method: Method;
  /** The path; each `:name` segment is a parameter: an id, or a CLI's `userCode`. */
  readonly path: string;
  /** Query parameters it may carry. */
  readonly query?: Readonly<Record<string, Field>>;
  /** The JSON body's fields; absent, the request has no body. */
  readonly body?: Readonly<Record<string, Field>>;
  /** False: the Mac's main process never sends it for its page (A541). */
  readonly pageMay?: false;
  /**
   * Its answer holds a code or a secret (re-review of PR #100). The Mac's main process hands a
   * page an answer with anything secret-shaped only from a request marked so (A543).
   */
  readonly returns?: 'secret';
}

/** Note, device, token and folder ids, as the server reads them (`NOTE_ID`). */
const id: Valid = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const text =
  (max: number): Valid =>
  (value) =>
    typeof value === 'string' && value.length <= max;
const orNull =
  (valid: Valid): Valid =>
  (value) =>
    value === null || valid(value);
const is =
  (expected: unknown): Valid =>
  (value) =>
    value === expected;
const bool: Valid = (value) => typeof value === 'boolean';
/**
 * The code a CLI shows (`ABCD-EFGH`), in whatever spacing or case it was typed: what is left
 * once the server drops white space and hyphens (`normaliseCode`) is letters and digits.
 */
const userCode: Valid = (value) =>
  typeof value === 'string' && value.length <= 64 && /^[A-Za-z0-9]{1,32}$/.test(bareCode(value));
const bareCode = (value: string) => value.replace(/[\s-]/g, '');
/** A GitHub repository, `owner/name`, as the server reads a mirror target (T43, A758). */
const repo: Valid = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(value);
/** An agent token reads, or writes; never admin (A15). */
const agentScopes: Valid = (value) =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= 2 &&
  value.every((scope) => scope === 'read' || scope === 'write');

const required = (valid: Valid): Field => ({ valid });
const optional = (valid: Valid): Field => ({ valid, optional: true });

export const ADMIN_REQUESTS = {
  // Settings → Devices
  listDevices: { check: null, method: 'GET', path: '/api/devices' },
  revokeDevice: { check: 'revokeDevice', method: 'DELETE', path: '/api/devices/:deviceId' },
  createToken: {
    check: 'createToken',
    method: 'POST',
    path: '/api/tokens',
    // The new agent token, shown to Ryan once.
    returns: 'secret',
    body: {
      // Any length, as the browser sends it (the server keeps the first 80 characters).
      label: optional(text(10_000)),
      scopes: required(agentScopes),
      folderId: optional(orNull(id)),
    },
  },
  revokeToken: { check: 'revokeToken', method: 'DELETE', path: '/api/tokens/:tokenId' },
  revokeAll: {
    check: 'revokeAll',
    method: 'POST',
    path: '/api/auth/revoke-all',
    body: { keepCurrent: optional(bool) },
  },
  // The new recovery code, shown to Ryan once.
  recoveryCode: {
    check: 'recoveryCode',
    method: 'POST',
    path: '/api/auth/recovery-code',
    returns: 'secret',
  },
  // Another sign-in: a CLI's code at /link, or a native app's approval page
  lookupSignIn: { check: null, method: 'GET', path: '/api/auth/device/:userCode' },
  approveSignIn: {
    check: 'approveSignIn',
    method: 'POST',
    path: '/api/auth/device/approve',
    body: { userCode: required(userCode), approve: required(is(true)) },
  },
  denySignIn: {
    check: null,
    method: 'POST',
    path: '/api/auth/device/approve',
    body: { userCode: required(userCode), approve: required(is(false)) },
  },
  approveAppSignIn: {
    check: 'approveSignIn',
    method: 'POST',
    path: '/api/auth/native/code',
    body: {
      redirectUri: required(text(512)),
      codeChallenge: required(text(128)),
      codeChallengeMethod: required(is('S256')),
      deviceKind: required((value) => value === 'mac' || value === 'android'),
      label: optional(orNull(text(10_000))),
    },
    // Its answer is a code that signs an app in: never for the Mac's page (B1).
    pageMay: false,
    returns: 'secret',
  },
  // Settings → Status, backups and the search index
  backup: { check: 'backup', method: 'POST', path: '/api/admin/backup' },
  listBackups: { check: null, method: 'GET', path: '/api/admin/backups' },
  listErrors: { check: null, method: 'GET', path: '/api/errors' },
  clearErrors: { check: 'clearErrors', method: 'DELETE', path: '/api/errors' },
  restoreNote: {
    check: 'restore',
    method: 'POST',
    path: '/api/admin/restore/notes/:noteId',
    body: { replace: optional(bool) },
  },
  restoreWorkspace: {
    check: 'restore',
    method: 'POST',
    path: '/api/admin/restore/workspace',
    body: { name: required(text(200)), replace: optional(bool) },
  },
  reindex: {
    check: 'reindex',
    method: 'POST',
    path: '/api/admin/reindex',
    query: { after: optional(id) },
  },
  rebuildIndex: {
    check: 'reindex',
    method: 'POST',
    path: '/api/admin/rebuild-index',
    query: { after: optional(id), vectors: optional(is('1')) },
  },
  searchIndex: { check: null, method: 'GET', path: '/api/admin/search-index' },
  // Trash
  purge: { check: 'purge', method: 'DELETE', path: '/api/notes/:noteId' },
  // Settings → Git Mirror: where each notebook is mirrored (T43, A758)
  setMirrorTarget: {
    check: 'mirrorTarget',
    method: 'PUT',
    path: '/api/admin/mirror/targets/:notebook',
    body: { repo: required(repo), branch: optional(text(200)), dir: optional(text(200)) },
  },
  removeMirrorTarget: {
    check: 'mirrorTarget',
    method: 'DELETE',
    path: '/api/admin/mirror/targets/:notebook',
  },
  // Settings → Git Mirror: a held note's notebook, confirmed (T43, A769)
  confirmNotebook: {
    check: 'confirmNotebook',
    method: 'POST',
    path: '/api/admin/notes/:noteId/notebook',
    // `record`: the note's own record as Settings showed it (null: none), a compare-and-set.
    body: { notebook: required(id), record: required(orNull(id)) },
  },
} as const satisfies Record<string, Spec>;

export type AdminRequestName = keyof typeof ADMIN_REQUESTS;

const SPECS: Readonly<Record<AdminRequestName, Spec>> = ADMIN_REQUESTS;

export function isAdminRequestName(value: unknown): value is AdminRequestName {
  return typeof value === 'string' && Object.hasOwn(ADMIN_REQUESTS, value);
}

/** The owner check a request needs first, or null (a read, or a denial). */
export function adminCheckOf(name: AdminRequestName): AdminAction | null {
  return SPECS[name].check;
}

/** Whether the request's answer holds a code or a secret (`returns`, A543). */
export function returnsSecret(name: AdminRequestName): boolean {
  return SPECS[name].returns === 'secret';
}

/** Whether the Mac's main process sends this request for its page (A541). */
export function pageMayAsk(name: AdminRequestName): boolean {
  return SPECS[name].pageMay !== false;
}

/** A CLI's code as the server shows it: `ABCD-EFGH` (apps/server `formatUserCode`). */
export function formatUserCode(value: string): string {
  const code = bareCode(value)
    .toUpperCase()
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replaceAll('O', '0');
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * What the owner check says a change is for, to follow “Penmoss is trying to …” (A504, review
 * of PR #100): one wording per change, with the details that tell them apart (a CLI's code, an
 * agent token's reach), from parameters `adminHttpRequest` has checked. Never a label or a
 * name the page wrote. Null for a request that asks no check.
 */
export function ownerCheckWords(name: AdminRequestName, params: Readonly<Record<string, unknown>>) {
  const replace = params['replace'] === true;
  switch (name) {
    case 'approveSignIn':
      return `approve the sign-in ${formatUserCode(String(params['userCode']))}`;
    case 'createToken': {
      const scopes = params['scopes'] as readonly string[];
      const can = scopes.includes('write') ? 'read and edit' : 'read';
      const reach =
        typeof params['folderId'] === 'string' ? 'the notes in one folder' : 'your notes';
      return `create an agent token that can ${can} ${reach}`;
    }
    case 'revokeAll':
      return params['keepCurrent'] === true
        ? 'sign out every other device'
        : 'sign out every device, this Mac too';
    case 'restoreNote':
      return replace ? 'replace a note with its backup' : 'restore a note from its backup';
    case 'restoreWorkspace':
      return replace
        ? 'replace your folders and notes with a backup'
        : 'restore your folders and notes from a backup';
    case 'rebuildIndex':
      return params['vectors'] === '1'
        ? 'rebuild the search index and its embeddings'
        : 'rebuild the search index';
    case 'reindex':
      return 'index your notes again for search';
    case 'approveAppSignIn':
      return 'approve an app’s sign-in';
    case 'setMirrorTarget':
      // The repository is checked (owner/name): the owner sees where the notes will go.
      return `mirror ${params['notebook'] === 'default' ? 'the default notebook' : 'a notebook'} to ${String(params['repo'])}`;
    case 'confirmNotebook': {
      // A record that names another notebook is said in the prompt too: the second, explicit
      // confirmation (A769), at the owner check itself.
      const other =
        typeof params['record'] === 'string' && params['record'] !== params['notebook']
          ? ' although its own record names another notebook'
          : '';
      return params['notebook'] === 'default'
        ? `confirm a held note is in the default notebook${other}`
        : `confirm a held note’s notebook so it is mirrored${other}`;
    }
    case 'removeMirrorTarget':
      return params['notebook'] === 'default'
        ? 'mirror the default notebook to its starting repository again'
        : 'stop mirroring a notebook';
    default: {
      const check = SPECS[name].check;
      return check ? ADMIN_ACTIONS[check] : null;
    }
  }
}

const segments = (path: string) => path.split('/').slice(1);
const paramOf = (segment: string) => (segment.startsWith(':') ? segment.slice(1) : null);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Checks `fields` in `params`; false when one is missing or of the wrong shape. */
function fieldsValid(
  fields: Readonly<Record<string, Field>> | undefined,
  params: Record<string, unknown>,
): boolean {
  for (const [key, field] of Object.entries(fields ?? {})) {
    if (!Object.hasOwn(params, key) || params[key] === undefined) {
      if (!field.optional) return false;
    } else if (!field.valid(params[key])) {
      return false;
    }
  }
  return true;
}

/**
 * The request main sends for `name` with `params` (main's side, A541), or null when the name is
 * unknown, or a parameter is missing, unknown or of the wrong shape.
 */
export function adminHttpRequest(name: unknown, params: unknown): AdminHttpRequest | null {
  if (!isAdminRequestName(name)) return null;
  const spec = SPECS[name];
  const given = params === undefined ? {} : params;
  if (!isRecord(given)) return null;
  const pathParams = segments(spec.path).flatMap((segment) => paramOf(segment) ?? []);
  const known = new Set([
    ...pathParams,
    ...Object.keys(spec.query ?? {}),
    ...Object.keys(spec.body ?? {}),
  ]);
  if (Object.keys(given).some((key) => !known.has(key))) return null;
  if (pathParams.some((key) => !(key === 'userCode' ? userCode : id)(given[key]))) return null;
  if (!fieldsValid(spec.query, given) || !fieldsValid(spec.body, given)) return null;

  const path = segments(spec.path)
    .map((segment) => {
      const key = paramOf(segment);
      return key ? encodeURIComponent(given[key] as string) : segment;
    })
    .join('/');
  const query = new URLSearchParams();
  for (const key of Object.keys(spec.query ?? {})) {
    if (given[key] !== undefined) query.set(key, given[key] as string);
  }
  const search = query.toString() ? `?${query.toString()}` : '';
  const request: AdminHttpRequest = { method: spec.method, path: `/${path}${search}` };
  if (!spec.body) return request;
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(spec.body)) {
    if (given[key] !== undefined) body[key] = given[key];
  }
  return { ...request, body: JSON.stringify(body) };
}

/**
 * Which admin request a page's API call is (the page's side, A541), or null when it needs no
 * admin token. Matched by method and path alone; the parameters are read as they are, for main
 * to check, so a call that matches a route is never sent by the page, valid or not.
 */
export function adminRequestOf(method: string, path: string, body?: unknown): AdminRequest | null {
  const verb = method.toUpperCase();
  const [bare = '', search = ''] = (path.split('#', 1)[0] ?? '').split('?', 2);
  const parts = segments(bare);
  for (const name of Object.keys(SPECS) as AdminRequestName[]) {
    const spec = SPECS[name];
    if (spec.method !== verb) continue;
    const pattern = segments(spec.path);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, unknown> = {};
    const matches = pattern.every((segment, index) => {
      const part = parts[index] ?? '';
      const key = paramOf(segment);
      if (!key) return segment === part;
      if (part === '') return false;
      try {
        params[key] = decodeURIComponent(part);
      } catch {
        params[key] = part;
      }
      return true;
    });
    if (!matches) continue;
    for (const [key, value] of new URLSearchParams(search)) params[key] = value;
    if (spec.body || body !== undefined) Object.assign(params, bodyParams(body));
    // Approving and denying a CLI share a route: the body says which (only a yes is checked).
    if (name === 'approveSignIn' && params['approve'] === false) {
      return { name: 'denySignIn', params };
    }
    if (name === 'denySignIn') continue;
    return { name, params };
  }
  return null;
}

/** A JSON object body's fields; anything else is passed on as `body`, which main refuses. */
function bodyParams(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null || body === '') return {};
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: refused below.
    }
  }
  return { body: typeof body === 'string' ? body : '[not text]' };
}
