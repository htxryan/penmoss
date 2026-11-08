/**
 * A writer (T50, A821): one install of one notebook. Its id names its files, so it writes only
 * its own. The id is bound to a secret kept outside the profile (the Keychain, the Keystore, the
 * CLI's credential store): a copied profile (a restored backup, a cloned data folder) has the
 * docs but not the secret, so it gets a new id and never writes into another writer's files.
 */
import { ulid } from '@penmoss/core';

export type WriterKind = 'device' | 'agent';

/** `Penmoss-Writer: <writer> (agent "<label>")`, as `commitMessage` writes it. */
const TRAILER = /^Penmoss-Writer: ([0-9A-Z]{26}) \((device|agent) "([^"]*)"\)$/m;

/** The writer a commit's trailer names, or null (a commit from before the trailer). */
export function commitWriter(
  message: string,
): { readonly id: string; readonly kind: WriterKind; readonly label: string } | null {
  const match = TRAILER.exec(message);
  if (!match) return null;
  return { id: match[1]!, kind: match[2] === 'agent' ? 'agent' : 'device', label: match[3]! };
}

/** What the profile keeps about its writer. */
export interface WriterRecord {
  readonly id: string;
  /** SHA-256 (hex) of the secret: the profile never holds the secret itself. */
  readonly secretHash: string;
  readonly kind: WriterKind;
  readonly label: string;
}

/** Where the writer's secret lives, outside the profile. */
export interface WriterSecrets {
  get(): Promise<string | null>;
  set(secret: string): Promise<void>;
}

export class MemorySecrets implements WriterSecrets {
  constructor(private secret: string | null = null) {}
  get(): Promise<string | null> {
    return Promise.resolve(this.secret);
  }
  set(secret: string): Promise<void> {
    this.secret = secret;
    return Promise.resolve();
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The profile's writer when its secret matches; otherwise a new writer (a first sync, or a copied
 * profile) with a new secret. `fresh` says which, so the caller resets its own client ids.
 */
export async function ensureWriter(
  current: WriterRecord | null,
  secrets: WriterSecrets,
  who: { readonly kind: WriterKind; readonly label: string },
  newId: () => string = ulid,
): Promise<{ writer: WriterRecord; fresh: boolean; previous: string | null }> {
  const secret = await secrets.get();
  if (current && secret && current.secretHash === (await sha256Hex(secret))) {
    const writer =
      current.label === who.label && current.kind === who.kind
        ? current
        : { ...current, kind: who.kind, label: who.label };
    return { writer, fresh: false, previous: null };
  }
  const next = newSecret();
  await secrets.set(next);
  return {
    writer: { id: newId(), secretHash: await sha256Hex(next), kind: who.kind, label: who.label },
    fresh: true,
    previous: current?.id ?? null,
  };
}
