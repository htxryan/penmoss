/**
 * The owner's session on the relay's own pages (PEN-193, R9): signed in with the relay's GitHub
 * App (no scopes), kept in the KV namespace, and named by an HttpOnly, Secure, SameSite=Lax
 * cookie. Each session has a form token: every form carries it, and a post without it, or from
 * another origin, is refused.
 */

const SESSION_COOKIE = 'penmoss_relay_session';
const SESSION_TTL_S = 12 * 60 * 60;

export interface Session {
  readonly id: string;
  readonly login: string;
  /** The form token. */
  readonly csrf: string;
}

export const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

const ID = /^[0-9a-f]{48}$/;

export function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

/** A cookie the relay sets: HttpOnly, Secure, SameSite=Lax, always. */
export const setCookie = (name: string, value: string, path: string, maxAge: number) =>
  `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${maxAge}`;

export async function startSession(kv: KVNamespace, login: string): Promise<Session> {
  const session = { id: randomId(), login, csrf: randomId() };
  await kv.put(`session:${session.id}`, JSON.stringify({ login, csrf: session.csrf }), {
    expirationTtl: SESSION_TTL_S,
  });
  return session;
}

export const sessionCookie = (session: Session) =>
  setCookie(SESSION_COOKIE, session.id, '/', SESSION_TTL_S);

export const clearSessionCookie = () => setCookie(SESSION_COOKIE, '', '/', 0);

export async function readSession(kv: KVNamespace, request: Request): Promise<Session | null> {
  const id = cookie(request, SESSION_COOKIE);
  if (!id || !ID.test(id)) return null;
  const stored = await kv.get(`session:${id}`);
  if (!stored) return null;
  const { login, csrf } = JSON.parse(stored) as { login: string; csrf: string };
  return { id, login, csrf };
}

export async function endSession(kv: KVNamespace, session: Session): Promise<void> {
  await kv.delete(`session:${session.id}`);
}

/** Whether a posted form is this session's own: from the relay's origin, with its token. */
export function formIsOwn(request: Request, form: FormData, session: Session): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) return false;
  const token = form.get('csrf');
  return (
    typeof token === 'string' && token.length === session.csrf.length && token === session.csrf
  );
}
