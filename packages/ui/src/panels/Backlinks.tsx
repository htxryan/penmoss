/**
 * The Backlinks panel (T16): notes that link to the open note, each with the
 * text around its links, and notes that mention its title without linking
 * (after the prototype's panel). Links in the text show their targets'
 * current titles; the open note's own links are highlighted. Presentational:
 * the app loads the lists (online from the index, offline from the replica).
 */
import { linkLabel, type ContextPart } from '@penmoss/core/links';
import { Fragment, type MouseEvent, type ReactNode } from 'react';

export interface BacklinkMention {
  readonly context: readonly ContextPart[];
  readonly embed: boolean;
  readonly heading: string | null;
}

export interface BacklinkNote {
  readonly id: string;
  readonly title: string;
  readonly mentions: readonly BacklinkMention[];
}

export interface MentionNote {
  readonly id: string;
  readonly title: string;
  readonly snippet: readonly { readonly text: string; readonly match: boolean }[];
}

export interface BacklinksProps {
  /** The open note. */
  readonly noteId: string;
  readonly linked: readonly BacklinkNote[];
  readonly unlinked: readonly MentionNote[];
  /** True while the lists are loading for the first time. */
  readonly loading?: boolean;
  /** Shown under the heading, e.g. that the lists come from this device only. */
  readonly note?: string | null;
  /** A note's current title (null when unknown), for links in the context. */
  readonly titleOf: (noteId: string) => string | null;
  readonly hrefOf: (noteId: string) => string;
  readonly onOpen: (noteId: string, event: MouseEvent<HTMLAnchorElement>) => void;
}

const shownTitle = (title: string) => title.trim() || 'Untitled';

function Context({
  parts,
  noteId,
  titleOf,
}: {
  parts: readonly ContextPart[];
  noteId: string;
  titleOf: (noteId: string) => string | null;
}): ReactNode {
  return parts.map((part, index) => {
    if (typeof part === 'string') return <Fragment key={index}>{part}</Fragment>;
    const label = linkLabel(part, part.noteId ? titleOf(part.noteId) : null);
    return part.noteId === noteId ? (
      <mark key={index}>{label}</mark>
    ) : (
      <span key={index} className="bl-link">
        {label}
      </span>
    );
  });
}

export function Backlinks(props: BacklinksProps) {
  const { noteId, linked, unlinked, loading, note, titleOf, hrefOf, onOpen } = props;
  const count = linked.length;
  return (
    <section className="backlinks" aria-labelledby="backlinks-heading" data-testid="backlinks">
      <h2 id="backlinks-heading" className="bl-heading">
        Backlinks <span className="bl-count">{loading ? '…' : count}</span>
      </h2>
      {note ? <p className="bl-note">{note}</p> : null}
      <h3 className="bl-group">
        Linked mentions <span className="bl-count">{count}</span>
      </h3>
      {count === 0 ? (
        <p className="bl-empty">
          {loading ? 'Looking for links…' : 'No other notes link here yet.'}
        </p>
      ) : (
        <ul className="bl-list" data-testid="linked-mentions">
          {linked.map((entry) => (
            <li key={entry.id} className="bl-item">
              <a
                className="bl-title"
                href={hrefOf(entry.id)}
                onClick={(event) => onOpen(entry.id, event)}
              >
                {shownTitle(entry.title)}
              </a>
              {entry.mentions.map((mention, index) => (
                <p key={index} className="bl-context">
                  {mention.embed ? <span className="bl-kind">Embeds </span> : null}
                  <Context parts={mention.context} noteId={noteId} titleOf={titleOf} />
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
      <h3 className="bl-group">
        Unlinked mentions <span className="bl-count">{unlinked.length}</span>
      </h3>
      {unlinked.length === 0 ? (
        <p className="bl-empty">{loading ? '' : 'No other notes mention this title.'}</p>
      ) : (
        <ul className="bl-list" data-testid="unlinked-mentions">
          {unlinked.map((entry) => (
            <li key={entry.id} className="bl-item">
              <a
                className="bl-title"
                href={hrefOf(entry.id)}
                onClick={(event) => onOpen(entry.id, event)}
              >
                {shownTitle(entry.title)}
              </a>
              <p className="bl-context">
                {entry.snippet.map((part, index) =>
                  part.match ? (
                    <mark key={index}>{part.text}</mark>
                  ) : (
                    <Fragment key={index}>{part.text}</Fragment>
                  ),
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
