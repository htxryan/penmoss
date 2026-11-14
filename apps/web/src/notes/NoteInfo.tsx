/**
 * The open note's Info panel and status bar (T41, A502, A505).
 *
 * The Info panel replaced the Backlinks panel: the note's details (folder,
 * created and edited, words, characters, reading time and Token Count, each its own row since
 * T62 item 4; a periodic note's kind as a label, A572; no save status, T62 item 5),
 * its tags (edited here;
 * the row under the title is gone), its frontmatter as the markdown copy
 * carries it, then the backlinks and unlinked mentions as before.
 *
 * The status bar shows the save status, read from the sync state the app
 * already keeps (`save-status.ts`), and the fields Settings → Display pins there
 * (the counts, unset; T62 item 4); `PinnedMetadata` shows those pinned under the title. Counting happens once
 * typing pauses, off the keystroke (`NoteStats`), and only this bar and the
 * panel re-render for it, never the note view (the T31 typing budget).
 */
import { readIdentity } from '@penmoss/sync-client/note';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';
import type { MetadataField } from '@penmoss/core/note-metadata';
import { useEffect, useId, useState } from 'react';
import { shortWhen } from '../shell/when';
import { NoteTags } from '../tags/NoteTags';
import { BacklinksPanel } from './BacklinksPanel';
import { useNoteNotebook, useNotebooks } from '../workspace/notebooks';
import { useAllSources, useSource } from '../sources/hooks';
import { useNoteMetadataSettings } from './metadata-state';
import { useNoteList } from './hooks';
import { useNoteCounts, useSaveStatus, type NoteStats } from './note-stats';
import { noteFields } from './markdown';
import type { SaveStatus } from './save-status';
import type { OpenNote } from './service';
import { kindLabel } from './kind';
import { Icon } from '@penmoss/ui/icons';
import { gitNotebookPath, linkHandler } from '../router';
import { charactersLabel, readingLabel, wordsLabel } from './stats';
import { tokensLabel } from './tokens';

function SaveStatusLabel({ status }: { status: SaveStatus | null }) {
  const source = useSource();
  if (!status) return <span className="save-status">Opening…</span>;
  // Sync stopped: a red pill, to the notebook's page in Settings, which says why and has Sync Now
  // (finding 12 of Ryan's review of #192; the sidebar's dot leads there too, A1098).
  if (status.state === 'stopped' && source?.kind === 'git') {
    const path = gitNotebookPath(source.id);
    return (
      <a
        className="save-status"
        data-state={status.state}
        data-ui="item"
        href={path}
        title={status.hint}
        aria-label={`${status.label}: ${status.hint}`}
        onClick={linkHandler(path)}
      >
        <Icon name="warning" size={12} />
        {status.label}
      </a>
    );
  }
  return (
    <span className="save-status" data-state={status.state} title={status.hint}>
      <span className="dot" aria-hidden="true" />
      {status.label}
    </span>
  );
}

/** The save states worth interrupting for: not saved, or sync stopped. */
const ANNOUNCED: ReadonlySet<SaveStatus['state']> = new Set(['error', 'stopped']);

/**
 * The bar along the bottom of the note: its save status on the left, the fields pinned to it on
 * the right (T62 item 4; Words, Characters and Reading Time unset), a selection's counts in place
 * of the note's. Hidden on a phone, where the format bar sits there; the Info panel has the same
 * facts.
 */
export function StatusBar({
  noteId,
  note,
  replica,
  folder,
  stats,
}: {
  noteId: string;
  note: OpenNote | null;
  replica: Yjs14Replica | null;
  folder: readonly string[];
  stats: NoteStats;
}) {
  const status = useSaveStatus(note);
  const { selection } = useNoteCounts(stats);
  const { statusBar } = useNoteMetadataSettings();
  const texts = useFieldTexts(noteId, replica, folder, stats);
  const counted = (field: MetadataField) =>
    field === 'words' || field === 'characters' || field === 'reading';
  const shown = statusBar.filter(
    (field): field is TextField => field !== 'tags' && !(selection && counted(field)),
  );
  return (
    <footer className="status-bar" data-testid="status-bar" aria-label="Note status">
      <span data-testid="save-status" data-state={status?.state ?? 'opening'}>
        <SaveStatusLabel status={status} />
      </span>
      {/* Read out only when it needs attention, never for routine saving and syncing (T41 review). */}
      <span className="sr-only" role="status" data-testid="save-alert">
        {status && ANNOUNCED.has(status.state) ? `${status.label}. ${status.hint}` : ''}
      </span>
      <span className="status-counts" data-testid="note-counts">
        {shown.map((field) =>
          texts[field] ? (
            <span key={field} data-field={field}>
              {texts[field]}
            </span>
          ) : null,
        )}
        {selection && statusBar.some(counted) ? (
          <span data-testid="selection-counts">
            {wordsLabel(selection.words)} and {charactersLabel(selection.characters)} selected
          </span>
        ) : null}
      </span>
    </footer>
  );
}

/**
 * The fields pinned under the title (T62 item 4), each as one short label in a row; Tags as
 * their chips with + to add one. Nothing when none is pinned.
 */
export function PinnedMetadata({
  noteId,
  replica,
  folder,
  stats,
  addingTag,
  onAddingTag,
}: {
  noteId: string;
  replica: Yjs14Replica | null;
  folder: readonly string[];
  stats: NoteStats;
  addingTag: boolean;
  onAddingTag: (adding: boolean) => void;
}) {
  const { underTitle } = useNoteMetadataSettings();
  const texts = useFieldTexts(noteId, replica, folder, stats);
  const entry = useNoteList().find((item) => item.id === noteId);
  const fields = useNoteDetails(noteId, replica)?.fields ?? {};
  if (underTitle.length === 0) return null;
  const frontmatterTags = Array.isArray(fields['tags']) ? (fields['tags'] as string[]) : [];
  const details = underTitle.filter((field) => field !== 'tags' && texts[field]);
  return (
    <div className="doc-meta" data-testid="pinned-metadata">
      {details.length > 0 ? (
        <span className="doc-meta-details">
          {details.map((field) => (
            <span key={field} className="doc-meta-field" data-field={field}>
              {texts[field as Exclude<MetadataField, 'tags'>]}
            </span>
          ))}
        </span>
      ) : null}
      {underTitle.includes('tags') ? (
        <NoteTags
          replica={replica}
          inline={(entry?.tags ?? []).filter((tag) => !frontmatterTags.includes(tag))}
          adding={addingTag}
          onAdding={onAddingTag}
        />
      ) : null}
    </div>
  );
}

/** When `iso` (frontmatter `created`, with its offset) was, in this device's words. */
function createdLabel(iso: string | undefined): string {
  if (!iso) return 'Unknown';
  const time = Date.parse(iso);
  return Number.isFinite(time) ? shortWhen(time) : iso;
}

function frontmatterValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

/** The details, read from the note's document at most every 300 ms while it changes (not per keystroke). */
function useNoteDetails(noteId: string, replica: Yjs14Replica | null) {
  const [details, setDetails] = useState<{
    readonly key: string;
    readonly fields: Record<string, unknown>;
    readonly period: string | null;
    readonly replica: Yjs14Replica;
  } | null>(null);
  useEffect(() => {
    if (!replica) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      timer = null;
      const fields = noteFields(noteId, replica) as unknown as Record<string, unknown>;
      const period = readIdentity(replica.doc).period ?? null;
      const key = JSON.stringify([fields, period]);
      setDetails((current) =>
        current?.key === key && current.replica === replica
          ? current
          : { key, fields, period, replica },
      );
    };
    read();
    const off = replica.onUpdate(() => {
      timer ??= setTimeout(read, 300);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [noteId, replica]);
  // Only the shown replica's details (none while the note is closed or reopening).
  return details && details.replica === replica ? details : null;
}

type TextField = Exclude<MetadataField, 'tags'>;

/** Each field's value as a short label, as the status bar and the row under the title show it. */
function useFieldTexts(
  noteId: string,
  replica: Yjs14Replica | null,
  folder: readonly string[],
  stats: NoteStats,
): Readonly<Record<TextField, string>> {
  const entry = useNoteList().find((item) => item.id === noteId);
  const notebook = useNoteNotebookName(noteId);
  const details = useNoteDetails(noteId, replica);
  const { doc, tokens } = useNoteCounts(stats);
  const created = details?.fields['created'];
  return {
    notebook,
    folder: folder.length > 0 ? folder.join(' / ') : 'Top level',
    created: details
      ? `Created ${createdLabel(typeof created === 'string' ? created : undefined)}`
      : '',
    edited: entry?.updatedAt ? `Edited ${shortWhen(entry.updatedAt)}` : '',
    words: doc ? wordsLabel(doc.words) : '',
    characters: doc ? charactersLabel(doc.characters) : '',
    reading: doc ? readingLabel(doc.minutes) : '',
    tokens: tokens !== null ? tokensLabel(tokens) : '',
  };
}

/** The note's notebook: its git notebook's name, or the notebook it is filed in. */
function useNoteNotebookName(noteId: string): string {
  const source = useSource();
  const notebook = useNoteNotebook(noteId);
  const notebooks = useNotebooks();
  return source?.name ?? notebook?.name ?? notebooks[0]?.name ?? '';
}

/** The Info panel, the side panel's Metadata tab since T51 (A936), beside the note (below it on narrow windows and phones). */
export function InfoPanel({
  noteId,
  replica,
  folder,
  stats,
  addingTag,
  onAddingTag,
}: {
  noteId: string;
  replica: Yjs14Replica | null;
  /** The folders the note is in, outermost first; empty at the top level. */
  folder: readonly string[];
  stats: NoteStats;
  addingTag: boolean;
  onAddingTag: (adding: boolean) => void;
}) {
  const id = useId();
  const entry = useNoteList().find((item) => item.id === noteId);
  const notebook = useNoteNotebook(noteId);
  const notebookName = useNoteNotebookName(noteId);
  const notebooks = useNotebooks();
  const gitNotebooks = useAllSources()?.all.length ?? 0;
  const details = useNoteDetails(noteId, replica);
  const { doc, tokens } = useNoteCounts(stats);
  const fields = details?.fields ?? {};
  const kind = kindLabel(fields['type']);
  const frontmatterTags = Array.isArray(fields['tags']) ? (fields['tags'] as string[]) : [];
  const inline = (entry?.tags ?? []).filter((tag) => !frontmatterTags.includes(tag));
  return (
    <section className="note-info" aria-labelledby={`${id}-h`} data-testid="note-info">
      <h2 id={`${id}-h`} className="info-heading">
        Metadata
      </h2>
      {kind ? (
        <p className="info-kind" data-testid="info-kind">
          <span className="chip">{kind}</span>
          {details?.period ? <span className="muted">{details.period}</span> : null}
        </p>
      ) : null}
      <dl className="info-list" data-testid="note-details">
        {/* T43: which notebook, so its repository; only once there are other notebooks. */}
        {notebooks.length > 1 || gitNotebooks > 1 ? (
          <>
            <dt>Notebook</dt>
            <dd data-testid="info-notebook">
              {notebookName}
              {notebook && notebooks.find((each) => each.id === notebook.id)?.open === false
                ? ' (closed on this device)'
                : ''}
            </dd>
          </>
        ) : null}
        <dt>Folder</dt>
        <dd data-testid="info-folder">{folder.length > 0 ? folder.join(' / ') : 'Top level'}</dd>
        <dt>Created</dt>
        <dd data-testid="info-created">
          {createdLabel(typeof fields['created'] === 'string' ? fields['created'] : undefined)}
        </dd>
        <dt>Edited</dt>
        <dd data-testid="info-edited">{entry?.updatedAt ? shortWhen(entry.updatedAt) : '—'}</dd>
        {/* No Saved row: it changed with every keystroke (T62 item 5); the status bar has it.
            Length is three rows, one per count (T62 item 4). */}
        <dt>Words</dt>
        <dd data-testid="info-words">{doc ? doc.words.toLocaleString('en-US') : '…'}</dd>
        <dt>Characters</dt>
        <dd data-testid="info-characters">{doc ? doc.characters.toLocaleString('en-US') : '…'}</dd>
        <dt>Reading Time</dt>
        <dd data-testid="info-reading">
          {doc ? (doc.minutes > 0 ? `${doc.minutes} min` : '—') : '…'}
        </dd>
        {/* An estimate, with GPT-4o's tokenizer (feedback of 6 Nov 2026; tokens.ts). */}
        <dt>Token Count</dt>
        <dd data-testid="info-tokens" title="Estimated with GPT-4o’s tokenizer">
          {tokens !== null ? tokens.toLocaleString('en-US') : '…'}
        </dd>
      </dl>
      <h3 className="info-subheading">Tags</h3>
      <NoteTags replica={replica} inline={inline} adding={addingTag} onAdding={onAddingTag} />
      {inline.length > 0 ? (
        <p className="info-inline-tags muted" data-testid="info-inline-tags">
          In the text: {inline.map((tag) => `#${tag}`).join(' ')}
        </p>
      ) : null}
      <h3 className="info-subheading">Frontmatter</h3>
      <dl className="info-frontmatter" data-testid="info-frontmatter">
        {Object.entries(fields).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{frontmatterValue(value)}</dd>
          </div>
        ))}
      </dl>
      <BacklinksPanel noteId={noteId} />
    </section>
  );
}
