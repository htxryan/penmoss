/**
 * Which release notes each app shows (PEN-109): apps/android/contract/release-notes-v1.json holds
 * a notes file and cases, each with a version (and the one before it, for the notice after an
 * update) and what `notesView` and `updatedNotice` make of it for Android. The Mac's page uses
 * these functions directly; Android's Kotlin checks itself against this file, so both apps pick
 * the same notes.
 *
 * After changing the selection, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/web exec vitest run release-notes-contract`,
 * then `pnpm exec prettier --write apps/android/contract/release-notes-v1.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DesktopReleaseNotes } from '../../src/desktop/bridge';
import { notesView, updatedNotice, type NotesBlock } from '../../src/updates/notes';

const FILE = fileURLToPath(
  new URL('../../../android/contract/release-notes-v1.json', import.meta.url),
);

const NOTES: DesktopReleaseNotes = {
  schema: 1,
  generated: '2026-11-20T00:00:00Z',
  releases: [
    { version: '0.2.0', tag: 'v0.2.0', build: 1170, date: '2026-11-08' },
    { version: '0.2.1', tag: 'v0.2.1', build: 1180, date: '2026-11-20' },
  ],
  notes: [
    { build: 1165, pr: 165, kind: 'new', platform: null, text: 'Quick capture.' },
    { build: 1168, pr: 168, kind: 'fixed', platform: 'mac', text: 'Mac only, before 0.2.0.' },
    { build: 1171, pr: 171, kind: 'fixed', platform: 'mac', text: 'Mac only, after 0.2.0.' },
    { build: 1172, pr: 172, kind: 'fixed', platform: 'android', text: 'The keyboard stays down.' },
    { build: 1174, pr: 174, kind: 'new', platform: null, text: 'Release notes in the app.' },
    { build: 1176, pr: 176, kind: 'improved', platform: 'mac', text: 'Mac only.' },
    { build: 1178, pr: 178, kind: 'improved', platform: null, text: 'Search ranks titles.' },
    { build: 1183, pr: 183, kind: 'new', platform: 'android', text: 'A What’s new screen.' },
    { build: 1185, pr: 185, kind: 'fixed', platform: null, text: 'Daily notes open right.' },
  ],
};

const CASES: ReadonlyArray<{
  readonly name: string;
  readonly current: string;
  readonly updatedFrom: string | null;
  readonly file?: DesktopReleaseNotes | null;
}> = [
  {
    name: 'a stable version: its own range, Android and both',
    current: '0.2.1',
    updatedFrom: null,
  },
  { name: 'the first stable release: everything up to it', current: '0.2.0', updatedFrom: null },
  {
    name: 'an Alpha build: everything since the last release, with builds',
    current: '0.2.2-alpha.1185',
    updatedFrom: '0.2.2-alpha.1183',
  },
  {
    name: 'an Alpha build before any release',
    current: '0.2.0-alpha.1168',
    updatedFrom: '0.1.9',
  },
  { name: 'updated to a stable version with notes', current: '0.2.1', updatedFrom: '0.2.0' },
  {
    name: 'updated to a build with only Mac notes: no notice',
    current: '0.2.1-alpha.1171',
    updatedFrom: '0.2.1-alpha.1170',
  },
  { name: 'a version the file does not know', current: '0.1.9', updatedFrom: '0.1.8' },
  { name: 'no file yet', current: '0.2.1', updatedFrom: '0.2.0', file: null },
  {
    name: 'a newer schema',
    current: '0.2.1',
    updatedFrom: null,
    file: { ...NOTES, schema: 2, notes: [], releases: [] },
  },
];

const block = (b: NotesBlock | null) =>
  b && {
    title: b.title,
    builds: b.builds,
    groups: b.groups.map((g) => ({ kind: g.kind, notes: g.notes.map((n) => [n.build, n.text]) })),
  };

function expected(file: DesktopReleaseNotes | null, current: string, updatedFrom: string | null) {
  const view = notesView(file, current, null, 'android');
  return {
    status: view.status,
    current: view.status === 'ok' ? block(view.current) : null,
    earlier: view.status === 'ok' ? view.earlier.map(block) : [],
    notice: updatedNotice(file, current, updatedFrom, 'android'),
  };
}

const contract = () => ({
  version: 1,
  notes: NOTES,
  cases: CASES.map(({ name, current, updatedFrom, file }) => ({
    name,
    current,
    updatedFrom,
    ...(file !== undefined ? { file } : {}),
    expected: expected(file === undefined ? NOTES : file, current, updatedFrom),
  })),
});

describe('the release notes contract (PEN-109)', () => {
  it("is what notes.ts makes for Android, so Android's Kotlin picks the same notes", () => {
    const made = contract();
    if (process.env['PENMOSS_WRITE_CONTRACTS'] === '1') {
      writeFileSync(FILE, `${JSON.stringify(made, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(made);
  });

  it('keeps Mac-only notes off Android and Android-only ones on it', () => {
    const view = notesView(NOTES, '0.2.1', null, 'android');
    if (view.status !== 'ok') throw new Error(view.status);
    const texts = view.current?.groups.flatMap((g) => g.notes.map((n) => n.text));
    expect(texts).toContain('The keyboard stays down.');
    expect(texts).not.toContain('Mac only.');
  });
});
