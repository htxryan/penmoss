/**
 * A git notebook's tags on this device: counts, descriptions (PEN-68), the notes with a tag, and
 * renaming or deleting one in every note at once (A125).
 */
import type { TagPromptNote } from '@penmoss/core/ai-description';
import { describeTags, normaliseTag, tagMatches, type DescribedTag } from '@penmoss/core/tags';
import type { EditOp } from '@penmoss/model/edit-engine';
import { readTagDescriptions } from '@penmoss/model/workspace';
import { LocalError, type NoteCatalog } from './catalog';

/** The most notes one tag listing returns. */
const MAX_LISTED = 200;

export class LocalTags {
  constructor(
    private readonly notes: NoteCatalog,
    /** The notebook's edit, which renames and deletes a tag in one note. */
    private readonly edit: (id: string, op: EditOp) => void,
  ) {}

  tags(): { tags: Array<{ name: string; notes: number; description?: string }> } {
    const counts = new Map<string, number>();
    for (const note of this.notes.live())
      for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const descriptions = readTagDescriptions(this.notes.workspace);
    return {
      tags: [...counts]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, notes]) => {
          const description = descriptions[name]?.trim();
          return { name, notes, ...(description ? { description } : {}) };
        }),
    };
  }

  /**
   * Every live note as a tag's AI description reads it (A1677), newest first: its title, tags,
   * description and text, for core's `tagPrompt`.
   */
  promptNotes(): TagPromptNote[] {
    return this.notes
      .live()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((note) => ({
        title: note.title,
        tags: note.tags,
        description: note.description,
        text: note.text,
      }));
  }

  describeTags(wanted?: readonly string[]): { tags: DescribedTag[] } {
    let names: string[] | undefined;
    if (wanted !== undefined) {
      names = [];
      for (const raw of wanted) {
        const name = normaliseTag(raw);
        if (!name) throw new LocalError(400, 'invalid_request', `Not a valid tag: ${raw}`);
        names.push(name);
      }
    }
    return {
      tags: describeTags(
        this.notes.live().map((note) => note.tags),
        readTagDescriptions(this.notes.workspace),
        names,
      ),
    };
  }

  tagged(tag: string, limit = MAX_LISTED) {
    const name = normaliseTag(tag);
    if (!name) throw new LocalError(400, 'invalid_request', 'Not a valid tag');
    const notes = this.notes
      .live()
      .filter((note) => note.tags.some((each) => tagMatches(each, name)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      tag: name,
      notes: notes
        .slice(0, limit)
        .map((note) => ({ id: note.id, title: note.title, updatedAt: note.updatedAt })),
      ...(notes.length > limit ? { truncated: true } : {}),
    };
  }

  renameTag(input: { readonly from: string; readonly to: string; readonly merge?: boolean }) {
    const from = normaliseTag(input.from);
    const to = normaliseTag(input.to);
    if (!from || !to) throw new LocalError(400, 'invalid_request', 'Not a valid tag');
    if (from === to) throw new LocalError(400, 'invalid_request', 'The tag already has that name');
    const all = this.notes.all();
    const has = (name: string) =>
      all.some((note) => note.tags.some((tag) => tagMatches(tag, name)));
    if (has(to) && !input.merge) {
      throw new LocalError(409, 'tag_exists', `#${to} exists already; pass merge to merge the two`);
    }
    const notes = all
      .filter((note) => note.tags.some((tag) => tagMatches(tag, from)))
      .map((n) => n.id);
    for (const id of notes) this.edit(id, { op: 'rename-tag', from, to });
    return { from, to, notes };
  }

  deleteTag(input: { readonly tag: string }) {
    const tag = normaliseTag(input.tag);
    if (!tag) throw new LocalError(400, 'invalid_request', 'Not a valid tag');
    const notes = this.notes
      .all()
      .filter((note) => note.tags.some((each) => tagMatches(each, tag)))
      .map((n) => n.id);
    for (const id of notes) this.edit(id, { op: 'delete-tag', tag });
    return { tag, notes };
  }
}
