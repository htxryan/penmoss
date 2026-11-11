// Types for release-note.mjs, so TypeScript callers (the factory, PEN-105) can import it.
export type Kind = 'new' | 'improved' | 'fixed';
export type Platform = 'mac' | 'android';
export interface Note {
  readonly kind: Kind;
  readonly platform: Platform | null;
  readonly text: string;
}
export interface ReleaseNote {
  readonly ok: boolean;
  readonly none: boolean;
  readonly notes: Note[];
  readonly errors: string[];
}
export const KINDS: readonly Kind[];
export const PLATFORMS: readonly Platform[];
export const MAX_NOTE: number;
export function parseReleaseNote(body: string | null | undefined): ReleaseNote;
export function formatNote(note: Note): string;
export function summary(result: ReleaseNote): string;
export function checkEvent(env: Record<string, string | undefined>): boolean;
