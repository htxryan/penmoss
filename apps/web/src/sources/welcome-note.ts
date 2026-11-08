/**
 * The note a notebook made on the first run starts with (T69, #228, A1146): a short guide to
 * what Penmoss does, at the top of the new notebook, opened when the app opens.
 */
import { ulid } from '@penmoss/core/ids';
import { isoWithOffset } from '@penmoss/sync-client/note';
import { recordFromUpdates } from '@penmoss/sync-client/records';
import type { Source } from './registry';

export const WELCOME_TITLE = 'Welcome to Penmoss';

export const WELCOME_MARKDOWN = `Your notes live in this notebook: Markdown files in your own git repository, synced by this Mac's git. Nothing goes to a Penmoss server.

## Start here

- **New note:** the + at the top of the sidebar, or ⌥⌘N.
- **Find anything:** ⌘⇧F searches every open notebook; ⌘K runs any command.
- **Link notes:** type \`[[\` and a note's title. Links show up as backlinks on the other note.
- **Tag notes:** type \`#\` and a tag, such as \`#ideas\`; nest them with /, such as \`#work/plans\`.
- **Journal:** today's note is one click away, in the sidebar's calendar.
- **Folders:** right-click in the sidebar for New Folder, Move, Duplicate and more.

## Keep going

- Settings → Git Notebooks adds more notebooks, or a personal access token for one.
- Agents can read and write your notes too: see Settings → Agents.

Delete this note whenever you like.
`;

/**
 * Writes the welcome note at the top of `source`, once its notes and folders are loaded, and
 * returns its id (null when the notebook already has notes: it was not new after all).
 */
export async function addWelcomeNote(
  source: Source,
  now: Date = new Date(),
): Promise<string | null> {
  await Promise.all([source.notes.start(), source.workspace.start()]);
  if (source.workspace.getState().snapshot.notes.length > 0) return null;
  const [codec, { markdownNote }] = await Promise.all([
    import('@penmoss/core'),
    import('@penmoss/editor/periodic'),
  ]);
  const id = ulid(now.getTime());
  const update = markdownNote(codec, {
    id,
    created: isoWithOffset(now),
    title: WELCOME_TITLE,
    markdown: WELCOME_MARKDOWN,
  });
  source.notes.addCopy(
    recordFromUpdates(id, [update], { epoch: null, unsynced: true, updatedAt: now.getTime() }),
  );
  source.workspace.registerNote(id, null);
  await source.notes.settled(id);
  return id;
}
