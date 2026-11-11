/**
 * The release notes in Settings → Updates (PEN-108): what the offered update brings, what this
 * version brought, and earlier versions, collapsed. Each block is a heading with its notes
 * grouped by kind, each group a heading and a list, so a screen reader announces them.
 */
import { useId } from 'react';
import { RELEASES_URL, useReleaseNotes } from './updates';
import { noteText, notesView, type NotesBlock } from './notes';

function Block({ block, testId }: { block: NotesBlock; testId: string }) {
  const id = useId();
  return (
    <div
      className="release-notes-block"
      data-testid={testId}
      aria-labelledby={`${id}-h`}
      role="group"
    >
      <h3 id={`${id}-h`}>{block.title}</h3>
      <Groups block={block} />
    </div>
  );
}

function Groups({ block }: { block: NotesBlock }) {
  if (block.groups.length === 0) {
    return <p className="muted">Nothing that people using Penmoss would notice.</p>;
  }
  return (
    <>
      {block.groups.map((group) => (
        <div key={group.kind} className="release-notes-group" data-kind={group.kind}>
          <h4>{group.label}</h4>
          <ul>
            {group.notes.map((note) => (
              <li key={`${note.pr}-${note.text}`}>{noteText(note, block.builds)}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

export function ReleaseNotes({ current, offered }: { current: string; offered: string | null }) {
  const file = useReleaseNotes();
  const view = notesView(file, current, offered);
  if (view.status !== 'ok') {
    return (
      <p className="muted release-notes-missing" data-testid="release-notes-missing">
        {view.status === 'newer'
          ? 'This version of Penmoss cannot read the newest release notes: '
          : 'Release notes show once Penmoss can reach GitHub. Until then, see '}
        <a href={RELEASES_URL} target="_blank" rel="noreferrer">
          {view.status === 'newer' ? 'read them on GitHub' : 'the releases on GitHub'}
        </a>
        .
      </p>
    );
  }
  return (
    <div className="release-notes" data-testid="release-notes">
      {view.offered ? <Block block={view.offered} testId="release-notes-offered" /> : null}
      {view.current ? <Block block={view.current} testId="release-notes-current" /> : null}
      {view.earlier.length > 0 ? (
        <details className="release-notes-earlier" data-testid="release-notes-earlier">
          <summary>Earlier versions</summary>
          {view.earlier.map((block) => (
            <Block key={block.title} block={block} testId="release-notes-release" />
          ))}
        </details>
      ) : null}
    </div>
  );
}
