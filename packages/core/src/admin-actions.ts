/**
 * Admin changes, and how a native app names them when it asks the OS to
 * check that its owner is there (T41, D34, A503). The server decides who may
 * administer (the `admin` scope); this table lets every client find the
 * requests that need its own check, from the method and path alone:
 *
 * - the web and Mac apps run every API request through `SessionManager.api`,
 *   which asks the Mac app (Touch ID, or a confirmation where there is none)
 *   before sending one of these;
 * - the Mac app's main process accepts only these ids and builds the words
 *   macOS shows from them, so a page cannot put its own text in the prompt;
 * - Android (T40 P2) asks BiometricPrompt or the screen lock before the same
 *   requests.
 *
 * Reads (`GET`) never ask: listing devices or errors changes nothing. The
 * server's test checks that every admin route that changes something is here.
 */

/** Each admin change and the words for it, to follow “Penmoss is trying to …”. */
export const ADMIN_ACTIONS = {
  purge: 'delete a note for good',
  revokeDevice: 'sign a device out',
  createToken: 'create an agent token',
  revokeToken: 'revoke an agent token',
  revokeAll: 'sign out every other device',
  recoveryCode: 'create a new recovery code',
  approveSignIn: 'approve a sign-in',
  backup: 'back up your notes now',
  clearErrors: 'clear the error reports',
  restore: 'restore from a backup',
  reindex: 'rebuild the search index',
  mirrorTarget: 'change where a notebook is mirrored',
  confirmNotebook: 'confirm which notebook a note is in',
  admin: 'make an admin change',
} as const;

export type AdminAction = keyof typeof ADMIN_ACTIONS;

/**
 * The admin routes, as method, path pattern and action. Exported for the Android app's contract
 * (`apps/android/contract/admin-actions-v1.json`, T40 P2a), so a route added here reaches the
 * phone's check or fails its test.
 */
export const ADMIN_ROUTES: ReadonlyArray<
  readonly [method: string, path: RegExp, action: AdminAction]
> = [
  ['DELETE', /^\/api\/notes\/[^/]+$/, 'purge'],
  ['DELETE', /^\/api\/devices\/[^/]+$/, 'revokeDevice'],
  ['POST', /^\/api\/tokens$/, 'createToken'],
  ['DELETE', /^\/api\/tokens\/[^/]+$/, 'revokeToken'],
  ['POST', /^\/api\/auth\/revoke-all$/, 'revokeAll'],
  ['POST', /^\/api\/auth\/recovery-code$/, 'recoveryCode'],
  ['POST', /^\/api\/auth\/device\/approve$/, 'approveSignIn'],
  ['POST', /^\/api\/auth\/native\/code$/, 'approveSignIn'],
  ['POST', /^\/api\/admin\/backup$/, 'backup'],
  ['DELETE', /^\/api\/errors$/, 'clearErrors'],
  ['POST', /^\/api\/admin\/restore\//, 'restore'],
  ['POST', /^\/api\/admin\/(?:rebuild-index|reindex)$/, 'reindex'],
  // Where a notebook's git mirror writes (T43, A758).
  ['PUT', /^\/api\/admin\/mirror\/targets\/[^/]+$/, 'mirrorTarget'],
  ['DELETE', /^\/api\/admin\/mirror\/targets\/[^/]+$/, 'mirrorTarget'],
  // A held note's notebook, confirmed so its mirror writes it (T43, A769).
  ['POST', /^\/api\/admin\/notes\/[^/]+\/notebook$/, 'confirmNotebook'],
];

/**
 * The admin change a request makes, or null for a read or anything a
 * read-write token may do. `path` may carry a query string. Anything else
 * that changes `/api/admin/…` counts as `admin`, so a new route is never
 * sent unchecked. Denying a CLI's sign-in (`{"approve": false}` to the
 * approve route) changes nothing anyone could use, so it is not checked
 * (T41 review); a body that cannot be read as exactly that is.
 */
export function adminActionOf(method: string, path: string, body?: unknown): AdminAction | null {
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return null;
  const bare = path.split(/[?#]/, 1)[0] ?? '';
  if (verb === 'POST' && DEVICE_APPROVE.test(bare) && isDenial(body)) return null;
  for (const [routeMethod, pattern, action] of ADMIN_ROUTES) {
    if (routeMethod === verb && pattern.test(bare)) return action;
  }
  return bare.startsWith('/api/admin/') ? 'admin' : null;
}

const DEVICE_APPROVE = /^\/api\/auth\/device\/approve$/;

/** A JSON body that says `approve: false`, and nothing that could read as yes. */
function isDenial(body: unknown): boolean {
  if (typeof body !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { approve?: unknown }).approve === false
    );
  } catch {
    return false;
  }
}

export function isAdminAction(value: unknown): value is AdminAction {
  return typeof value === 'string' && Object.hasOwn(ADMIN_ACTIONS, value);
}
