// Which release notes Settings → Updates shows (PEN-108): apps/web/src/updates/notes.ts.
import { describe, expect, it } from 'vitest';
import type { DesktopReleaseNote, DesktopReleaseNotes } from '../../src/desktop/bridge';
import { alphaBuildOf, buildFor, notesView, type NotesBlock } from '../../src/updates/notes';

const note = (
  build: number,
  kind: DesktopReleaseNote['kind'],
  text: string,
  platform: DesktopReleaseNote['platform'] = null,
): DesktopReleaseNote => ({ build, pr: build - 1000, kind, platform, text });

const FILE: DesktopReleaseNotes = {
  schema: 1,
  generated: '2026-11-20T00:00:00Z',
  releases: [
    { version: '0.2.0', tag: 'v0.2.0', build: 1170, date: '2026-11-08' },
    { version: '0.2.1', tag: 'v0.2.1', build: 1180, date: '2026-11-20' },
  ],
  notes: [
    note(1165, 'new', 'Before 0.2.0.'),
    note(1172, 'fixed', 'The window keeps its size.', 'mac'),
    note(1174, 'new', 'Release notes in the app.'),
    note(1176, 'fixed', 'The keyboard stays down.', 'android'),
    note(1178, 'improved', 'Search ranks titles first.'),
    note(1183, 'new', 'After 0.2.1.'),
    note(1185, 'fixed', 'Daily notes open on the right day.'),
  ],
};

/** A block as [kind, texts] pairs. */
const read = (block: NotesBlock | null | undefined) =>
  block ? block.groups.map((group) => [group.label, group.notes.map((n) => n.text)]) : null;

describe('notesView', () => {
  it('says there are no notes without a file, and defers to GitHub for a newer schema', () => {
    expect(notesView(null, '0.2.1', null)).toEqual({ status: 'none' });
    expect(notesView({ ...FILE, schema: 2 }, '0.2.1', null)).toEqual({ status: 'newer' });
  });

  it("shows a stable version's own range, grouped by kind, Mac notes only", () => {
    const view = notesView(FILE, '0.2.1', null);
    if (view.status !== 'ok') throw new Error(view.status);
    expect(view.offered).toBeNull();
    expect(view.current?.title).toBe('In this version');
    expect(view.current?.builds).toBe(false);
    expect(read(view.current)).toEqual([
      ['New', ['Release notes in the app.']],
      ['Improved', ['Search ranks titles first.']],
      ['Fixed', ['The window keeps its size.']],
    ]);
    expect(view.earlier.map((block) => [block.title, read(block)])).toEqual([
      ['0.2.0', [['New', ['Before 0.2.0.']]]],
    ]);
  });

  it('shows what a stable update brings: after this build, up to the offered one', () => {
    const view = notesView(FILE, '0.2.0', '0.2.1');
    if (view.status !== 'ok') throw new Error(view.status);
    expect(view.offered?.title).toBe("What's new in 0.2.1");
    expect(read(view.offered)?.flatMap(([, texts]) => texts)).toEqual([
      'Release notes in the app.',
      'Search ranks titles first.',
      'The window keeps its size.',
    ]);
    expect(read(view.current)).toEqual([['New', ['Before 0.2.0.']]]);
    expect(view.earlier).toEqual([]);
  });

  it('shows an Alpha build its notes since the last stable release, with builds', () => {
    const view = notesView(FILE, '0.2.2-alpha.1185', null);
    if (view.status !== 'ok') throw new Error(view.status);
    expect(view.current?.title).toBe('In this version (since 0.2.1)');
    expect(view.current?.builds).toBe(true);
    expect(read(view.current)).toEqual([
      ['New', ['After 0.2.1.']],
      ['Fixed', ['Daily notes open on the right day.']],
    ]);
    expect(view.earlier.map((block) => block.title)).toEqual(['0.2.1', '0.2.0']);
  });

  it('shows what an Alpha update brings, build by build', () => {
    const view = notesView(FILE, '0.2.2-alpha.1183', '0.2.2-alpha.1185');
    if (view.status !== 'ok') throw new Error(view.status);
    expect(view.offered?.title).toBe("What's new in build 1185");
    expect(view.offered?.builds).toBe(true);
    expect(read(view.offered)).toEqual([['Fixed', ['Daily notes open on the right day.']]]);
  });

  it('shows empty blocks when a range has no notes, and no offer for an older version', () => {
    const quiet = { ...FILE, notes: FILE.notes.filter((n) => n.build < 1172 || n.build > 1180) };
    const view = notesView(quiet, '0.2.1', null);
    if (view.status !== 'ok') throw new Error(view.status);
    expect(view.current?.groups).toEqual([]);
    const back = notesView(FILE, '0.2.1', '0.2.0');
    if (back.status !== 'ok') throw new Error(back.status);
    expect(back.offered).toBeNull();
  });

  it('lists every stable release for a version the file does not know', () => {
    const view = notesView(FILE, '0.1.436', null);
    if (view.status !== 'ok') throw new Error(view.status);
    expect(view.current).toBeNull();
    expect(view.earlier.map((block) => block.title)).toEqual(['0.2.1', '0.2.0']);
  });
});

describe('builds', () => {
  it('reads an Alpha build from its version and a stable one from the file', () => {
    expect(alphaBuildOf('0.2.2-alpha.1185')).toBe(1185);
    expect(alphaBuildOf('0.2.1')).toBeNull();
    expect(buildFor(FILE, '0.2.1')).toBe(1180);
    expect(buildFor(FILE, '0.3.0')).toBeNull();
  });
});
