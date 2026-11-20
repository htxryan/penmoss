/**
 * The release notes in Settings → Updates (PEN-108): what the offered update brings, what this
 * version brought, and earlier versions, collapsed. Each block is a heading with its notes
 * grouped by kind, each group a heading and a list, so a screen reader announces them. What's
 * New holds them folded away (A1567), its summary saying the version and how many changes.
 */
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useRef, useState } from 'react';
import { RELEASES_URL, useReleaseNotes } from './updates';
import {
  noteText,
  notesView,
  WHATS_NEW_PATH,
  whatsNewSummary,
  type NotesBlock,
  type NotesView,
} from './notes';

/** Settings → Updates was opened to show what changed: the notice after an update (PEN-110). */
const openedToShow = () =>
  window.location.search === WHATS_NEW_PATH.slice(WHATS_NEW_PATH.indexOf('?'));

/**
 * Settings → Updates' What's New (A1567): a disclosure, folded by default, its summary the
 * section's heading with the version and its count of changes. Open when the page was opened to
 * show what changed (the notice after an update) and while an update is offered, which is what
 * the notes are for then. Its state lasts while the page is open, and is not kept.
 */
export function WhatsNew({
  current,
  offered,
  since = null,
}: {
  current: string;
  offered: string | null;
  /** The version Penmoss ran before this one, where an Alpha build's notes start. */
  since?: string | null;
}) {
  const file = useReleaseNotes();
  const [open, setOpen] = useState(() => openedToShow() || offered !== null);
  // An update found while the page is open: what it brings, unfolded.
  const [seen, setSeen] = useState(offered);
  if (offered !== seen) {
    setSeen(offered);
    if (offered !== null) setOpen(true);
  }
  const id = useId();
  const view = notesView(file, current, offered, 'mac', since);
  return (
    <details
      className="updates-whats-new"
      data-setting="whats-new"
      data-testid="whats-new"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        data-event="settings.updates.whats-new"
        className="lf-sub updates-whats-new-summary"
        data-testid="whats-new-summary"
      >
        <Icon name="chevR" size={14} className="updates-whats-new-chevron" />
        <h3 className="lf-sub-name" id={`${id}-h`}>
          What’s New
        </h3>
        <span className="lf-sub-hint" data-testid="whats-new-count">
          {whatsNewSummary(view, current, offered)}
        </span>
      </summary>
      <ReleaseNotesView view={view} />
    </details>
  );
}

function Block({
  block,
  testId,
  scrollTo = false,
}: {
  block: NotesBlock;
  testId: string;
  scrollTo?: boolean;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Opened from the notice after an update (PEN-110): this block, its heading focused.
    if (!scrollTo || !heading.current) return;
    heading.current.scrollIntoView({ block: 'start' });
    heading.current.focus({ preventScroll: true });
  }, [scrollTo]);
  return (
    <div
      className="release-notes-block"
      data-testid={testId}
      aria-labelledby={`${id}-h`}
      role="group"
    >
      <h3 id={`${id}-h`} ref={heading} tabIndex={scrollTo ? -1 : undefined}>
        {block.title}
      </h3>
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

/** The notes, or a link to GitHub while there are none to show. */
function ReleaseNotesView({ view }: { readonly view: NotesView }) {
  if (view.status !== 'ok') {
    return (
      <p className="muted release-notes-missing" data-testid="release-notes-missing">
        {view.status === 'newer'
          ? 'This version of Penmoss cannot read the newest release notes: '
          : 'Release notes show once Penmoss can reach GitHub. Until then, see '}
        <a href={RELEASES_URL} target="_blank" rel="noreferrer" data-event="link.release-notes">
          {view.status === 'newer' ? 'read them on GitHub' : 'the releases on GitHub'}
        </a>
        .
      </p>
    );
  }
  return (
    <div className="release-notes" data-testid="release-notes">
      {view.offered ? <Block block={view.offered} testId="release-notes-offered" /> : null}
      {view.current ? (
        <Block block={view.current} testId="release-notes-current" scrollTo={openedToShow()} />
      ) : null}
      {view.earlier.length > 0 ? (
        <details className="release-notes-earlier" data-testid="release-notes-earlier">
          <summary data-event="settings.updates.whats-new.earlier">Earlier Versions</summary>
          {view.earlier.map((block) => (
            <Block key={block.title} block={block} testId="release-notes-release" />
          ))}
        </details>
      ) : null}
    </div>
  );
}
