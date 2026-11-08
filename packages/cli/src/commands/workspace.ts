/**
 * restore, attach, settings and retag (T42 item 12, A568): what the CLI may do beyond editing
 * notes, each through the notebook's local route the MCP tools use, attributed to the clone's
 * writer. Deleting a note for good stays the apps' (A15).
 */
import { UsageError } from '../args';
import type { Command } from '../command';
import { ApiError, CliError, EXIT } from '../errors';
import { named } from '../format';
import { resolveNote } from '../refs';

const NOTE_HELP =
  'A note is its id or its exact title, ignoring the case of A–Z only; a note in Trash is named by its id.';
const notePath = (id: string, action = '') => `/api/notes/${encodeURIComponent(id)}${action}`;

export const restore: Command = {
  name: 'restore',
  summary: 'Take a note out of Trash',
  usage: ['restore <note>'],
  description: [
    'Takes the note out of Trash, back into the folder it was deleted from (the top level if that folder is gone). A note not in Trash stays where it is.',
    NOTE_HELP,
  ],
  flags: [],
  examples: ['penmoss restore 01JABCDEFGHJKMNPQRSTVWXYZ0'],
  async run(context) {
    const [ref] = context.args(['note']);
    const api = await context.api();
    const note = await resolveNote(api, ref!);
    // The notebook files it in the same change (restore_note's command): never a note out of
    // Trash and out of every folder.
    const reply = await api.request<{ id: string; restored: boolean; folderId: string | null }>(
      'POST',
      notePath(note.id, '/restore'),
      { body: {} },
    );
    context.emit({ id: note.id, restored: reply.restored, folderId: reply.folderId }, () =>
      reply.restored
        ? `Restored ${named(note.title, note.id)} from Trash.`
        : `${named(note.title, note.id)} was not in Trash.`,
    );
  },
};

/** The largest file an agent sends (as the MCP tools' attach_file). */
const MAX_KB = 700;

/** Base64 of `bytes`, a chunk at a time (one call per byte would overflow the stack). */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export const attach: Command = {
  name: 'attach',
  summary: 'Attach a file or picture to a note',
  usage: ['attach <note> <file> [--alt <text>] [--heading <heading>]'],
  description: [
    'Stores the file and adds it at the end of the note, or of the section under --heading: a picture (PNG, JPEG, GIF, WebP, AVIF) shows in the note, any other file is a link. At most 700 KB. A file the note already has is not added twice.',
    NOTE_HELP,
  ],
  flags: [
    {
      name: 'alt',
      type: 'string',
      value: 'text',
      description: 'Words for a picture (its alt text)',
    },
    { name: 'heading', type: 'string', value: 'heading', description: 'Add it under this heading' },
  ],
  examples: ['penmoss attach "Garden plan" bed-layout.png --alt "Bed layout"'],
  async run(context) {
    const [ref, file] = context.args(['note', 'file']);
    if (!context.io.readFile) throw new CliError(EXIT.ERROR, 'This CLI cannot read files here.');
    const tooLarge = (size: number) =>
      new CliError(
        EXIT.REFUSED,
        `${file} is ${Math.ceil(size / 1024)} KB; penmoss attach sends files of at most ${MAX_KB} KB. Attach larger ones in the app.`,
        'file_too_large',
      );
    // Its size first, so a large file is refused without reading it (T42 review N9).
    const size = await context.io.fileSize?.(file!).catch(() => undefined);
    if (size !== undefined && size > MAX_KB * 1024) throw tooLarge(size);
    let bytes: Uint8Array;
    try {
      bytes = await context.io.readFile(file!);
    } catch {
      throw new UsageError(`cannot read the file “${file}”`);
    }
    if (bytes.length > MAX_KB * 1024) throw tooLarge(bytes.length);
    const api = await context.api();
    const note = await resolveNote(api, ref!);
    const name = file!.split(/[\\/]/).pop() ?? file!;
    const alt = context.string('alt');
    const heading = context.string('heading');
    const reply = await api.request<{ path: string; added: boolean; markdown: string }>(
      'POST',
      notePath(note.id, '/attachments'),
      {
        body: {
          name,
          data: base64(bytes),
          ...(alt === undefined ? {} : { alt }),
          ...(heading === undefined ? {} : { heading }),
        },
      },
    );
    context.emit(reply, () =>
      reply.added
        ? `Attached ${name} to ${named(note.title, note.id)}: ${reply.markdown}`
        : `${named(note.title, note.id)} already has ${name}.`,
    );
  },
};

/** A value typed on the command line: true and false are booleans, anything else text. */
function settingValue(text: string): string | boolean {
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text;
}

export const settings: Command = {
  name: 'settings',
  summary: 'Show or change your settings',
  usage: ['settings', 'settings <key>', 'settings <key> <value>', 'settings <key> --reset'],
  description: [
    'Shows the notebook’s settings (those not listed have their defaults), one of them, or changes one as the apps do. A notebook keeps timeZone (e.g. America/Chicago), template.daily and template.weekly; the apps’ own settings (theme.id, theme.mode, capture.destination, note.fullWidth) are refused (exit 3). --reset brings back its default.',
    'A change is checked with the apps’ rules; if the setting changed on another device since this command read it, nothing changes (exit 5).',
  ],
  flags: [{ name: 'reset', type: 'boolean', description: 'Bring back the setting’s default' }],
  examples: [
    'penmoss settings',
    'penmoss settings theme.mode dark',
    'penmoss settings timeZone --reset',
  ],
  async run(context) {
    const [key, value] = context.args(['key', 'value'], 2);
    const reset = context.bool('reset');
    const api = await context.api();
    const now = (await api.get<{ settings: Record<string, unknown> }>('/api/settings')).settings;
    if (key === undefined) {
      if (reset) throw new UsageError('--reset needs a key');
      context.emit({ settings: now }, () =>
        Object.keys(now).length === 0
          ? 'Every setting has its default.'
          : Object.entries(now)
              .filter(([name]) => !name.startsWith('theme.custom.'))
              .map(([name, each]) => `${name}  ${JSON.stringify(each)}`),
      );
      return;
    }
    if (value === undefined && !reset) {
      context.emit({ key, value: now[key] ?? null }, () =>
        key in now ? JSON.stringify(now[key]) : `${key} has its default.`,
      );
      return;
    }
    if (value !== undefined && reset) throw new UsageError('give a value or --reset, not both');
    const next = reset ? null : settingValue(value!);
    try {
      const reply = await api.request<{ settings: Record<string, unknown>; changed: boolean }>(
        'PUT',
        '/api/settings',
        { body: { set: { [key]: next }, base: { [key]: now[key] ?? null } } },
      );
      context.emit({ key, value: reply.settings[key] ?? null, changed: reply.changed }, () =>
        reset ? `${key} has its default again.` : `${key} is ${JSON.stringify(next)}.`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === 'invalid_setting') {
        throw new CliError(EXIT.REFUSED, error.message, error.code, error.details, error.hints);
      }
      throw error;
    }
  },
};

export const retag: Command = {
  name: 'retag',
  summary: 'Rename or merge a tag in every note',
  usage: ['retag <from> <to> [--merge]'],
  description: [
    'Renames the tag in every note that has it, nested tags included (projects/garden follows projects). Renaming to a tag that exists merges the two, and needs --merge (exit 5 without it). The rename is an edit of each note, so it is not in the notebook’s Agent activity: each note’s History reverts its part (Revert this edit), and the repository’s history keeps every change.',
  ],
  flags: [{ name: 'merge', type: 'boolean', description: 'Merge into a tag that exists already' }],
  examples: ['penmoss retag garden gardening', 'penmoss retag veg vegetables --merge'],
  async run(context) {
    const [from, to] = context.args(['from', 'to']);
    const tag = (text: string) => text.trim().replace(/^#/, '');
    const api = await context.api();
    const reply = await api.request<{ from: string; to: string; notes: string[] }>(
      'POST',
      '/api/tags/rename',
      {
        body: { from: tag(from!), to: tag(to!), ...(context.bool('merge') ? { merge: true } : {}) },
      },
    );
    context.emit(
      reply,
      () =>
        `Renaming #${reply.from} to #${reply.to} in ${reply.notes.length} ${reply.notes.length === 1 ? 'note' : 'notes'}.`,
    );
  },
};
