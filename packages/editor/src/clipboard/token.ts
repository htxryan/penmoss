/**
 * The value of Penmoss's clipboard marker (T15, A51): a random token per
 * install, kept in localStorage, that a copy writes and a paste checks. Any
 * page can write `data-penmoss` in its own copy handler; it cannot know this
 * value unless HTML copied from this install was pasted into it, and even
 * then the marker unlocks nothing that matters for safety (see sanitize.ts):
 * it only keeps a copy between notes exact.
 */
const KEY = 'penmoss.clipboardToken';
const TOKEN = /^[0-9a-f]{32}$/;

let token: string | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // Blocked site data.
  }
}

/** This install's clipboard token (created on first use; per session when storage is unavailable). */
export function clipboardToken(): string {
  if (token) return token;
  const store = storage();
  let stored: string | null;
  try {
    stored = store?.getItem(KEY) ?? null;
  } catch {
    stored = null;
  }
  if (stored && TOKEN.test(stored)) {
    token = stored;
    return token;
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  token = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  try {
    store?.setItem(KEY, token);
  } catch {
    // Not stored: this session's copies still match its pastes.
  }
  return token;
}
