/**
 * `SEARCH_VAULT` as the index sees it: each note's markdown parsed by the
 * codec, then read the way the NoteDoc renders a note for search (body text
 * one line per text block, headings, heading sections).
 */
import type { DocJson } from '../../src/links';
import { parseMarkdown } from '../../src/markdown/parse';
import { noteHeadings, noteSections, type NoteSection } from '../../src/search';
import { SEARCH_VAULT, type VaultNote } from './search-vault';

export interface VaultDocument extends VaultNote {
  /** As the server's `text`: each text block's text on its own line. */
  readonly text: string;
  readonly headings: string;
  readonly sections: NoteSection[];
  readonly updatedAt: number;
  readonly json: DocJson;
}

export function vaultDocuments(notes: readonly VaultNote[] = SEARCH_VAULT): VaultDocument[] {
  return notes.map((note) => {
    const { doc } = parseMarkdown(note.body);
    const lines: string[] = [];
    doc.descendants((node) => {
      if (node.isTextblock) {
        lines.push(node.textContent);
        return false;
      }
      return true;
    });
    const json = doc.toJSON() as DocJson;
    return {
      ...note,
      text: lines.filter(Boolean).join('\n'),
      headings: noteHeadings(json),
      sections: noteSections(json),
      updatedAt: Date.parse(`${note.updated}T00:00:00Z`),
      json,
    };
  });
}
