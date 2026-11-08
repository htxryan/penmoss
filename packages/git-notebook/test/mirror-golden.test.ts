/**
 * The server mirror's output is byte-identical after its code moved into the shared packages
 * (T50 G1, #149; A832). `fixtures/mirror-golden.json` was recorded by running the corpus against
 * the server's own modules (`apps/server/src/do/markdown.ts`, `mirror/paths.ts`, `tree.ts` and
 * `workspace-tree.ts`) before they moved; the same corpus over `@penmoss/core/mirror` and
 * `@penmoss/editor/markdown` must give every path, name, id and byte again. The mirror's own
 * render (`mirrorMarkdown`, which the NoteDoc and git notebooks both call) must agree too.
 * (The workerd suite's `mirror-default-paths.test.ts` runs the real mirror against its fixture.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assetPrefix,
  assignFolders,
  folderDirs,
  gitTextSha,
  nameKey,
  noteName,
  notePath,
  sanitizeName,
  textHash,
  uniqueName,
} from '@penmoss/core/mirror';
import { journalFolderId, periodicNoteId } from '@penmoss/core/periodic';
import {
  attachmentFiles,
  localAttachment,
  mirrorMarkdown,
  noteBody,
  noteStamp,
  readNoteState,
  renderNote,
} from '@penmoss/editor/markdown';
import { periodicNote } from '@penmoss/editor/periodic';
import { describe, expect, it } from 'vitest';
import { mirrorCorpus, type MirrorCode, type MirrorGolden } from './support/mirror-corpus';

const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'mirror-golden.json'), 'utf8'),
) as MirrorGolden;

const shared = {
  readNoteState,
  renderNote,
  localAttachment,
  attachmentFiles,
  noteBody,
  noteStamp,
  assignFolders,
  folderDirs,
  noteName,
  nameKey,
  uniqueName,
  notePath,
  assetPrefix,
  sanitizeName,
  gitTextSha,
  textHash,
  periodicNoteId,
  journalFolderId,
  periodicNote,
} as unknown as MirrorCode;

describe('the server mirror after the shared-code extraction (A832)', () => {
  it('gives every path, name and byte the server modules gave before the move', async () => {
    const now = await mirrorCorpus(shared);
    expect(now.folders).toEqual(golden.folders);
    expect(now.notes.map((note) => note.path)).toEqual(golden.notes.map((note) => note.path));
    for (const [i, note] of now.notes.entries()) {
      expect(note.markdown, golden.notes[i]!.path).toBe(golden.notes[i]!.markdown);
      expect(note.sha).toBe(golden.notes[i]!.sha);
    }
    expect(now).toEqual(golden);
  });

  it('renders through mirrorMarkdown exactly as the NoteDoc composed it', async () => {
    const seen: Array<{ id: string; markdown: string }> = [];
    const viaShared: MirrorCode = {
      ...shared,
      // The corpus composes links and asset paths as NoteDoc.mirrorRender did; the shared
      // function must make the same bytes from the same names and prefix.
      renderNote: (state, noteId, changedAt, options) => {
        const rendered = renderNote(state, noteId, changedAt, options);
        const link = (id: string) => {
          const name = options.links?.linkText(id) ?? null;
          return name === null ? null : { name, title: options.links?.title?.(id) ?? name };
        };
        const prefix = /^((?:\.\.\/)*)attachments\//.exec(
          options.assetUrl?.(`attachments/${'0'.repeat(64)}.png`) ?? '',
        )?.[1];
        const again = mirrorMarkdown(state, noteId, changedAt, {
          link,
          assetPrefix: prefix ?? '',
        });
        seen.push({ id: noteId, markdown: again.markdown });
        return rendered;
      },
    };
    const now = await mirrorCorpus(viaShared);
    expect(seen.map((each) => each.markdown)).toEqual(now.notes.map((note) => note.markdown));
  });

  it('keeps unsalted periodic ids and updates as the server workspace has them (A820)', async () => {
    const now = await mirrorCorpus(shared);
    expect(now.periodic).toEqual(golden.periodic);
    expect(now.periodicUpdates).toEqual(golden.periodicUpdates);
  });
});
