/**
 * The note registry as the editor's links see it (T16): current titles,
 * fuzzy completion, creating a note from a link, and opening one. Everything
 * comes from the merged note list (local replica first, A7), so links and
 * completion work offline. A note that is not listed (deleted, or not on this
 * device yet) has no title, and its links show as broken until it returns.
 */
import { FuzzyMatcher } from '@penmoss/core/fuzzy';
import { headingsOf, type DocJson } from '@penmoss/core/links';
import type { LinkResolver } from '@penmoss/core';
import type { LinkServices, NoteCandidate, OpenWhere } from '@penmoss/editor';
import { displayTitle, type NoteListEntry } from './list';
import type { Notes } from './service';

export interface DirectoryOptions {
  readonly notes: Notes;
  /** The folder a note is filed in (null: top level, or unknown). */
  readonly folderOf: (noteId: string) => string | null;
  /** A folder's name, for completion details. */
  readonly folderName: (folderId: string) => string | null;
  /** The note's git path, once the mirror has assigned one (A10, T27). */
  readonly pathOf?: (noteId: string) => string | null;
  /** Files a new note in the registry. */
  readonly register: (noteId: string, folderId: string | null) => void;
  /** Opens a path in the app (History API), in a new tab, or a note in a new window (T45). */
  readonly navigate: (path: string) => void;
  readonly openTab?: (path: string) => void;
  readonly openWindow?: (noteId: string, heading: string | null) => void;
}

/** The app path of a note, at a heading when given. */
export function noteHref(noteId: string, heading: string | null = null): string {
  const path = `/notes/${encodeURIComponent(noteId)}`;
  return heading ? `${path}?heading=${encodeURIComponent(heading)}` : path;
}

export class NoteDirectory implements LinkServices {
  private entries: readonly NoteListEntry[] = [];
  private byId = new Map<string, NoteListEntry>();

  /**
   * @param source the note the editor shows: new notes made from its links
   * are filed beside it.
   */
  constructor(
    private readonly options: DirectoryOptions,
    private readonly source: string | null = null,
    /** Titles folded for `[[` completion, kept across keystrokes (shared by `forNote`). */
    private readonly matcher = new FuzzyMatcher(),
  ) {}

  /** The note this editor shows (embeds of it are cycles, T13). */
  get noteId(): string | null {
    return this.source;
  }

  /** A note's body for embeds (T13): its open replica, else this device's copy. */
  body(noteId: string): Promise<DocJson | null> {
    return this.options.notes.body(noteId);
  }

  /** Follows a note's changes while an embed shows it (T13), live over its socket. */
  watch(noteId: string, listener: () => void): () => void {
    return this.options.notes.watchNote(noteId, listener);
  }

  /** The same registry for another note's editor. */
  forNote(noteId: string): NoteDirectory {
    return new NoteDirectory(this.options, noteId, this.matcher);
  }

  title(noteId: string): string | null {
    const entry = this.list().get(noteId);
    return entry ? displayTitle(entry.title) : null;
  }

  search(query: string, limit: number): readonly NoteCandidate[] {
    this.list();
    const others = this.entries.filter((entry) => entry.id !== this.source);
    return this.matcher
      .filter(others, query, (entry) => displayTitle(entry.title), limit)
      .map((entry) => {
        const folder = this.options.folderOf(entry.id);
        const name = folder ? this.options.folderName(folder) : null;
        return {
          id: entry.id,
          title: displayTitle(entry.title),
          ...(name ? { detail: name } : {}),
        };
      });
  }

  resolve(title: string): string | null {
    const wanted = title.trim().toLowerCase();
    if (!wanted) return null;
    this.list();
    // Newest first, as the list is: an ambiguous title links the most recently edited note.
    return this.entries.find((entry) => entry.title.trim().toLowerCase() === wanted)?.id ?? null;
  }

  create(title: string): string | null {
    const clean = title.trim();
    if (!clean) return null;
    const folderId = this.source ? this.options.folderOf(this.source) : null;
    const id = this.options.notes.create(new Date(), { title: clean, focus: false, folderId });
    this.options.register(id, folderId);
    return id;
  }

  open(noteId: string, heading: string | null, where: OpenWhere = 'here'): void {
    if (where === 'window' && this.options.openWindow) {
      this.options.openWindow(noteId, heading);
      return;
    }
    const path = noteHref(noteId, heading);
    if (where === 'tab' && this.options.openTab) this.options.openTab(path);
    else this.options.navigate(path);
  }

  async headings(noteId: string): Promise<readonly string[]> {
    const body = await this.options.notes.body(noteId);
    if (!body) return [];
    return [
      ...new Set(
        headingsOf(body)
          .map((heading) => heading.text.trim())
          .filter(Boolean),
      ),
    ];
  }

  /**
   * How the markdown codec writes links (T16, A10): the current title, or the
   * note's path (`[[path|Title]]`) when another note has the same title and a
   * path is known; a note that is not listed keeps the text it was linked with.
   */
  linkResolver(): LinkResolver {
    const byId = this.list();
    const counts = new Map<string, number>();
    for (const entry of this.entries) {
      const key = entry.title.trim().toLowerCase();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const title = (noteId: string) => byId.get(noteId)?.title.trim() || null;
    return {
      resolve: (target) => this.resolve(target),
      linkText: (noteId) => {
        const current = title(noteId);
        if (!current) return null;
        const path = this.options.pathOf?.(noteId) ?? null;
        return (counts.get(current.toLowerCase()) ?? 0) > 1 && path
          ? path.replace(/\.md$/i, '')
          : current;
      },
      title,
    };
  }

  subscribe(listener: () => void): () => void {
    return this.options.notes.subscribe(listener);
  }

  /** The note list by id, rebuilt only when the list changed. */
  private list(): Map<string, NoteListEntry> {
    const current = this.options.notes.list();
    if (current !== this.entries) {
      this.entries = current;
      this.byId = new Map(current.map((entry) => [entry.id, entry]));
    }
    return this.byId;
  }
}
