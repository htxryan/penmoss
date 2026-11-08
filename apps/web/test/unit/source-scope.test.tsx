// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useNotes } from '../../src/notes/hooks';
import type { Notes } from '../../src/notes/service';
import { NotesProvider } from '../../src/notes/context';
import { SourceScopeOr } from '../../src/sources/context';
import { useSource } from '../../src/sources/hooks';
import type { Source } from '../../src/sources/registry';

// T50 (A862): the overlays and toasts sit in the open note's source, and none is open on the
// home screen. Mounted again when a note opened, the Trash toast took focus back from the new
// note's title (the Mac suite's "nothing that clicks drags the window" failed first).
function Probe({ mounts, seen }: { mounts: number[]; seen: string[] }) {
  const notes = useNotes() as unknown as { name: string };
  const source = useSource();
  seen.push(`${source?.id ?? 'none'}:${notes.name}`);
  useEffect(() => {
    mounts.push(1);
  }, [mounts]);
  return null;
}

describe('SourceScopeOr', () => {
  it('keeps what is under it mounted when a source comes and goes, and gives the right services', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const own = { name: 'own' } as unknown as Notes;
    const git = {
      id: 'git-1',
      notes: { name: 'git' },
      workspace: {},
      directory: {},
    } as unknown as Source;
    const root = createRoot(document.createElement('div'));
    const mounts: number[] = [];
    const seen: string[] = [];
    const tree = (source: Source | null) => (
      <NotesProvider notes={own}>
        <SourceScopeOr source={source}>
          <Probe mounts={mounts} seen={seen} />
        </SourceScopeOr>
      </NotesProvider>
    );
    act(() => root.render(tree(null)));
    act(() => root.render(tree(git)));
    act(() => root.render(tree(null)));
    expect(mounts).toHaveLength(1);
    expect(seen).toEqual(['none:own', 'git-1:git', 'none:own']);
    act(() => root.unmount());
  });
});
