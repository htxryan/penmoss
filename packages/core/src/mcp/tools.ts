/**
 * The MCP tools' definitions (T25; shared since T50, A830): each tool's name, title, description
 * for agents, the JSON Schema of its arguments and its annotations. The remote server on
 * `/mcp` (apps/server/src/mcp/tools.ts) and the local server over a git notebook
 * (`penmoss mcp --notebook`, @penmoss/git-notebook/local) both advertise these, each with its own
 * handlers, so a tool means the same everywhere. Also the advice both give with a refusal.
 */
import type { ObjectSchema, Schema } from './schema';

/** How the search tool's modes are named (the server's search route takes the same). */
export const SEARCH_MODES = ['full-text', 'semantic', 'hybrid'] as const;

/** What a tool is, without what it does. */
export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ObjectSchema;
  /** Changes notes: hidden from read-only tokens and refused for them. */
  readonly write: boolean;
  readonly annotations: {
    readonly title?: string;
    readonly readOnlyHint: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint: false;
  };
  /** Appended to an arguments error (what the agent should have sent). */
  readonly hint?: string;
  /**
   * Checks the note `id` itself: a folder-scoped token reaches a note it may restore, in Trash
   * from inside its folder, although the tree no longer files it there (A566).
   */
  readonly ownIdCheck?: boolean;
  /** Changes the whole workspace: hidden from folder-scoped tokens, which are refused it (N8). */
  readonly workspaceWide?: boolean;
}

/** What differs between servers in what the tools say. */
export interface ToolOptions {
  /** The largest file attach_file takes, in bytes. */
  readonly attachmentMaxBytes: number;
  /** Advice per refusal code that replaces this server's (a local server's own). */
  readonly advice?: Readonly<Record<string, string>>;
}

// --- argument schemas ---

export const ID: Schema = {
  type: 'string',
  maxLength: 80,
  description:
    'The note id (26 characters) or its short id (e.g. K7QD-9HTF2CXA), from search_notes, list_recent or list_folder.',
};
export const FOLDER_ID: Schema = {
  type: 'string',
  maxLength: 80,
  description: 'The folder id, from list_folder.',
};
export const VERSION_ID: Schema = {
  type: 'integer',
  minimum: 1,
  description: 'A version id from get_history.',
};
export const BASE_VERSION: Schema = {
  type: 'integer',
  minimum: 1,
  description:
    'The baseVersion your last read_note (or last edit of this note) returned: the version your edit is based on.',
};
export const MARKDOWN: Schema = {
  type: 'string',
  description:
    'Markdown (CommonMark plus GFM tables and task lists). [[Note title]] links to another note.',
};
export const TAGS: Schema = {
  type: 'array',
  maxItems: 100,
  items: { type: 'string', maxLength: 200 },
  description: 'Tag names without #, e.g. ["homelab", "projects/garden"] (nested with /).',
};

export const object = (
  properties: Record<string, Schema>,
  required: readonly string[] = [],
): ObjectSchema => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

export const READ = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export const BASE_HINT =
  'Call read_note first and pass the baseVersion it returns (or the baseVersion your previous edit of this note returned).';

// --- advice ---

/** The REST error codes, as advice for an agent. */
function guidance(attachmentMaxBytes: number): Record<string, string> {
  return {
    not_found:
      'No note with this id in your workspace. Find ids with search_notes, list_recent or list_folder.',
    base_required: BASE_HINT,
    base_unknown:
      'That baseVersion is too old or unknown. Call read_note again, check the text, and retry with the new baseVersion.',
    in_trash:
      'The note is in Trash. Restore it with restore_note (a folder-scoped token: when it was deleted from inside its folder), or Ryan can in the app; it cannot be changed until then.',
    folder_not_found: 'Find folder ids with list_folder.',
    unknown_properties: 'Only title and tags can be set.',
    text_not_found: 'Call read_note to see the exact text; find must match it exactly.',
    text_ambiguous:
      'Make find longer so it occurs once, or set all: true to replace every occurrence.',
    too_large: 'Send at most 256 KB of markdown per call; split a long edit into several appends.',
    offset_past_end: 'Pass the nextOffset a previous read_note returned, or leave offset out.',
    folder_changed:
      'Someone renamed the folder since you saw it: call list_folder again, then retry with its current name as expectedName.',
    folder_moved:
      'Someone moved the folder since you saw it: call list_folder again, then retry with its current parent as expectedParentId.',
    folder_cycle: 'Choose a parent outside the folder you are moving.',
    scope_folder: 'Change the folders inside it instead.',
    outside_scope: 'This token is limited to one folder; this change reaches beyond it.',
    setting_changed: 'Call get_settings again, then retry with the values it gives as base.',
    invalid_setting: 'Call get_settings to see the settings and their current values.',
    version_not_found: 'Call get_history to list the note’s versions.',
    file_too_large: `Send a file of at most ${attachmentMaxBytes / 1024} KB; Ryan can attach larger ones in the app.`,
    daily_limit: 'Stop and tell Ryan what is left to do; he can do it in the app.',
    too_many_renames:
      'Wait for the running renames to finish, or ask Ryan to rename the tag in the app.',
    tag_exists:
      'Check with list_tags that merging the two tags is what Ryan wants, then call rename_tag again with merge: true.',
    setting_not_allowed: 'Ask Ryan to change it in the app’s Settings.',
    // The comment tools' (A775, A1064).
    thread_not_found:
      'Call list_comment_threads with the note id (status "all" includes resolved threads).',
    comment_not_found: 'Call read_comment_thread to see the thread’s comments and their ids.',
    quote_not_found:
      'Call read_note and copy a short passage exactly as written (one sentence works best).',
    occurrence_not_found: 'Pass an occurrence from 1 up to the number of times the text occurs.',
    too_many_threads: 'Reply in an existing thread instead.',
    too_many_comments: 'Start a new thread instead.',
    agent_not_allowed: 'Ryan does this in the app.',
    not_your_comment: 'Reply in the thread instead.',
  };
}

/** The advice for one refusal code, when there is some. */
export function adviceFor(code: string, options: ToolOptions): string | undefined {
  if (options.advice && Object.hasOwn(options.advice, code)) return options.advice[code];
  const all = guidance(options.attachmentMaxBytes);
  return Object.hasOwn(all, code) ? all[code] : undefined;
}

/**
 * What to do about a 409 conflict, naming who changed the part when the note
 * knows (A176): another device or agent, the agent's own later edit, or
 * neither ("This part changed…"). Never "someone else" for the agent's own edit.
 */
export function conflictAdvice(details: Record<string, unknown>): string {
  const others = Array.isArray(details['changedBy'])
    ? (details['changedBy'] as unknown[]).filter((each): each is string => typeof each === 'string')
    : [];
  const you = details['changedByYou'] === true;
  const redo =
    'call read_note again, then redo your edit on the current text with the new baseVersion.';
  if (others.length > 0) {
    const names =
      others.length === 1 ? others[0]! : `${others.slice(0, -1).join(', ')} and ${others.at(-1)!}`;
    return (
      `${names}${you ? ' (and your own later edit)' : ''} changed this part of the note after your baseVersion. ` +
      `Do not overwrite that change blindly: ${redo}`
    );
  }
  if (you) {
    return (
      'Your own later edit changed this part of the note after this baseVersion: you passed an older one. ' +
      `Use the baseVersion your last edit returned, or ${redo}`
    );
  }
  return `This part changed after your baseVersion. ${redo.charAt(0).toUpperCase()}${redo.slice(1)}`;
}

/**
 * A refusal (the REST API's `{ code, message, details }`) as tool error text: what went wrong
 * and what to do next, so an agent can correct itself.
 */
export function describeRefusal(
  error: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: Record<string, unknown>;
  },
  options: ToolOptions,
): string {
  const code = error.code ?? 'error';
  const lines = [`${error.message ?? 'The request failed'} (${code}).`];
  const details = error.details ?? {};
  if (code === 'conflict') {
    lines.push(conflictAdvice(details));
    if (typeof details['current'] === 'string') {
      lines.push(
        `Current text of ${typeof details['target'] === 'string' ? details['target'] : 'the target'}:\n${details['current']}`,
      );
    }
  } else if (code === 'heading_not_found' || code === 'heading_ambiguous') {
    const headings = Array.isArray(details['headings']) ? (details['headings'] as string[]) : [];
    lines.push(
      headings.length > 0
        ? `The note's headings: ${headings.join(' | ')}. Name one exactly (e.g. "## Plans" to pick a level).`
        : 'The note has no headings: use append_to_note without a heading.',
    );
  } else {
    const advice = adviceFor(code, options);
    if (advice) lines.push(advice);
  }
  return lines.join('\n');
}

// --- the tools ---

/** Every tool but the comment tools (`commentToolDefinitions`: the local MCP's only, A1064), in list order. */
export function toolDefinitions(options: ToolOptions): readonly ToolDefinition[] {
  return [
    {
      name: 'search_notes',
      title: 'Search notes',
      description:
        'Search the notes. mode "hybrid" (default) combines keyword and meaning search and suits questions in plain language; ' +
        '"full-text" matches words exactly ("a phrase", prefix*, -excluded, title:word); "semantic" finds notes by meaning only. ' +
        'Filter by folderId (with its subfolders), tag (with nested tags) and updated time. ' +
        'Results give each note id, title, a snippet with matches in **bold**, tags and when it was last updated; call read_note for the full text.',
      inputSchema: object(
        {
          query: { type: 'string', maxLength: 500, description: 'What to look for.' },
          mode: {
            type: 'string',
            enum: SEARCH_MODES,
            description: 'hybrid (default), full-text or semantic.',
          },
          folderId: { type: 'string', maxLength: 80, description: 'Only notes in this folder.' },
          tag: { type: 'string', maxLength: 200, description: 'Only notes with this tag.' },
          updatedAfter: {
            type: 'string',
            description: 'Only notes edited after this ISO 8601 date or time, e.g. 2026-10-01.',
          },
          updatedBefore: {
            type: 'string',
            description: 'Only notes edited before this ISO 8601 date or time.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description: 'At most this many (10).',
          },
        },
        ['query'],
      ),
      write: false,
      annotations: { ...READ, title: 'Search notes' },
    },
    {
      name: 'read_note',
      title: 'Read a note',
      description:
        'Read a note: its title, tags, headings and markdown body, and its baseVersion. ' +
        'Keep the baseVersion: every edit tool takes it, and update_section and replace_text require it, so an edit only goes ahead if the part you change is still as you read it. ' +
        'Read again before editing if some time has passed. ' +
        'A long body comes in parts of about 60 KB: when truncated is true, call again with offset set to nextOffset, or read just one section with heading. ' +
        'A line may start with symbols, each a glyph and a space after any list marker, checkbox or heading hashes (★ important, ? question, ! follow-up, 💡 idea, → next): plain text the apps draw in the margin; write one the same way to mark a line.',
      inputSchema: object(
        {
          id: ID,
          heading: {
            type: 'string',
            maxLength: 500,
            description: 'Read only the section under this heading (e.g. "Plans" or "## Plans").',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description: 'Start here: the nextOffset of the previous part of a long note.',
          },
        },
        ['id'],
      ),
      write: false,
      annotations: { ...READ, title: 'Read a note' },
    },
    {
      name: 'list_folder',
      title: 'List a folder',
      description:
        'List the folders and notes in a folder, in the order the app shows them. ' +
        'Give folderId, or path (folder names from the top, e.g. "Journal/2026"), or neither for the top level. ' +
        'Folder ids are what create_note, move_note and search_notes take. ' +
        'Every folder and note names its notebook (a top-level folder whose notes Ryan mirrors to a git repository of its own; "default" is the rest). ' +
        "At the top level, notebooks have isNotebook: true. You may work inside a notebook, but not create, rename or delete one, or move notes or folders between notebooks: those are Ryan's.",
      inputSchema: object({
        folderId: { type: 'string', maxLength: 80, description: 'The folder id.' },
        path: {
          type: 'string',
          maxLength: 1000,
          description: 'The folder path, e.g. "Projects/Garden".',
        },
      }),
      write: false,
      annotations: { ...READ, title: 'List a folder' },
    },
    {
      name: 'list_tags',
      title: 'List tags',
      description:
        'Without tag: every tag with how many notes have it, and its description when Ryan wrote one (what the tag means). With tag: the notes that have it or a tag nested under it (newest first, at most 200; truncated: true when there are more).',
      inputSchema: object({
        tag: { type: 'string', maxLength: 200, description: 'A tag, without #.' },
      }),
      write: false,
      annotations: { ...READ, title: 'List tags' },
    },
    {
      name: 'describe_tags',
      title: 'Describe tags',
      description:
        "What tags mean, in Ryan's words: each tag with its description (null when he wrote none), how many notes have it or a tag nested under it, and the descriptions of the tags above it (ancestors, outermost first) as context. " +
        'A parent tag does not describe its children: each has its own. Without tags: every tag. With tags: those, and the tags nested under each. ' +
        'Read it before choosing tags for a note, or to understand what a tag in a search or a note is for.',
      inputSchema: object({
        tags: {
          type: 'array',
          maxItems: 100,
          items: { type: 'string', maxLength: 200 },
          description:
            'Tags, without #, e.g. ["project/penmoss"]; a parent includes its nested tags.',
        },
      }),
      write: false,
      annotations: { ...READ, title: 'Describe tags' },
    },
    {
      name: 'get_backlinks',
      title: 'Get backlinks',
      description:
        'The notes that link to a note ([[its title]]), with the heading of each link, and the notes that mention its title without linking.',
      inputSchema: object({ id: ID }, ['id']),
      write: false,
      annotations: { ...READ, title: 'Get backlinks' },
    },
    {
      name: 'list_recent',
      title: 'List recent notes',
      description:
        'The most recently edited notes, newest first, with their tags and a short excerpt. Daily and weekly journal notes have kind "daily" or "weekly".',
      inputSchema: object({
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'At most this many (20).',
        },
      }),
      write: false,
      annotations: { ...READ, title: 'List recent notes' },
    },
    {
      name: 'get_history',
      title: 'Get note history',
      description:
        'A note’s saved versions, newest first: when, by whom (devices and agents by name) and what changed. ' +
        'With versionId: that version’s markdown and the lines it added (+) and removed (−). Ryan can restore or revert versions in the app.',
      inputSchema: object(
        {
          id: ID,
          versionId: { type: 'integer', minimum: 1, description: 'A version id from the list.' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'At most this many (20).',
          },
        },
        ['id'],
      ),
      write: false,
      annotations: { ...READ, title: 'Get note history' },
    },
    {
      name: 'get_daily_note',
      title: 'Get the daily note',
      description:
        'Get today’s daily note, creating it from Ryan’s template if no device has yet (with a write token), exactly as the apps do: ' +
        '“today” is in Ryan’s time zone setting, and the note is filed under Journal. ' +
        'date (YYYY-MM-DD) picks another day; period "weekly" gives the weekly note of the week holding that day. ' +
        'Returns the note like read_note (with its baseVersion and headings); add to it with append_to_note, optionally under one of its headings.',
      inputSchema: object({
        date: {
          type: 'string',
          maxLength: 10,
          description: 'A day as YYYY-MM-DD; today (in Ryan’s time zone) if omitted.',
        },
        period: {
          type: 'string',
          enum: ['daily', 'weekly'],
          description: 'daily (default) or weekly.',
        },
      }),
      write: false,
      annotations: { ...WRITE, idempotentHint: true, title: 'Get the daily note' },
    },
    {
      name: 'create_note',
      title: 'Create a note',
      description:
        'Create a note with a title, a markdown body and tags, at the top level or in folderId. ' +
        'Returns its id and baseVersion. For today’s journal use get_daily_note instead. ' +
        'A call identical to one that made a note less than 10 minutes ago returns that note (created: false) rather than a copy, and leaves it where it is, so retrying after an error is safe; pass a different idempotencyKey to make a deliberate duplicate.',
      inputSchema: object({
        title: { type: 'string', maxLength: 500, description: 'The title.' },
        markdown: { ...MARKDOWN, description: `The body. ${MARKDOWN.description}` },
        tags: TAGS,
        folderId: { type: 'string', maxLength: 80, description: 'A folder id from list_folder.' },
        idempotencyKey: {
          type: 'string',
          maxLength: 200,
          description: 'Any unique text; a retry with the same key returns the same note.',
        },
      }),
      write: true,
      annotations: { ...WRITE, title: 'Create a note' },
    },
    {
      name: 'append_to_note',
      title: 'Append to a note',
      description:
        'Add markdown at the end of a note, or at the end of the section under heading (e.g. "Notes" or "## Notes"). ' +
        'Nothing already there is changed, so baseVersion is optional; pass it when you have it. Returns the new baseVersion.',
      inputSchema: object(
        {
          id: ID,
          markdown: MARKDOWN,
          heading: {
            type: 'string',
            maxLength: 500,
            description: 'Add at the end of this heading’s section instead of the end of the note.',
          },
          baseVersion: BASE_VERSION,
        },
        ['id', 'markdown'],
      ),
      write: true,
      annotations: { ...WRITE, title: 'Append to a note' },
    },
    {
      name: 'update_section',
      title: 'Update a section',
      description:
        'Replace the content under a heading (the heading itself stays; subsections are part of the section), or insert at its start (mode "prepend") or end (mode "append"). ' +
        'Requires baseVersion from read_note: if a person changed that section since, the edit is refused with a conflict and the current text; ' +
        'then call read_note again and redo the edit on the current text. Edits elsewhere in the note never conflict. Returns the new baseVersion.',
      inputSchema: object(
        {
          id: ID,
          heading: {
            type: 'string',
            maxLength: 500,
            description:
              'The heading as read_note lists it, e.g. "Plans" or "## Plans"; its leading symbols (★, ?, …) may be left out.',
          },
          markdown: MARKDOWN,
          mode: {
            type: 'string',
            enum: ['replace', 'prepend', 'append'],
            description: 'replace (default), prepend or append.',
          },
          baseVersion: BASE_VERSION,
        },
        ['id', 'heading', 'markdown', 'baseVersion'],
      ),
      write: true,
      annotations: { ...WRITE, destructiveHint: true, title: 'Update a section' },
      hint: BASE_HINT,
    },
    {
      name: 'replace_text',
      title: 'Find and replace',
      description:
        'Replace text in a note’s body. find must occur exactly once unless all is true. ' +
        'scope "text" (default) matches prose only, never link targets; "markdown" matches the raw markdown. ' +
        'Requires baseVersion from read_note: if the lines around a match changed since, the edit is refused with a conflict; then call read_note again and retry. Returns the new baseVersion.',
      inputSchema: object(
        {
          id: ID,
          find: { type: 'string', description: 'The exact text to find.' },
          replace: { type: 'string', description: 'What to put in its place (markdown).' },
          all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
          scope: {
            type: 'string',
            enum: ['text', 'markdown'],
            description: 'text (default: prose only) or markdown.',
          },
          baseVersion: BASE_VERSION,
        },
        ['id', 'find', 'replace', 'baseVersion'],
      ),
      write: true,
      annotations: { ...WRITE, destructiveHint: true, title: 'Find and replace' },
      hint: BASE_HINT,
    },
    {
      name: 'set_properties',
      title: 'Set title or tags',
      description:
        'Set a note’s title, or replace its tag list (the tags in its properties; #tags written in the text stay). ' +
        'Use tag_note to add or remove single tags. baseVersion is optional: with it, the change is refused if the title or tags changed since you read them.',
      inputSchema: object(
        {
          id: ID,
          title: { type: 'string', maxLength: 500, description: 'The new title.' },
          tags: { ...TAGS, description: `The complete new tag list. ${TAGS.description}` },
          baseVersion: BASE_VERSION,
        },
        ['id'],
      ),
      write: true,
      annotations: { ...WRITE, destructiveHint: true, title: 'Set title or tags' },
    },
    {
      name: 'move_note',
      title: 'Move a note',
      description:
        'Move a note into a folder (folderId from list_folder), or to the top level with folderId null. The note keeps its id and links.',
      inputSchema: object(
        {
          id: ID,
          folderId: {
            type: ['string', 'null'],
            description: 'The folder to move it to; null for the top level.',
          },
        },
        ['id', 'folderId'],
      ),
      write: true,
      annotations: { ...WRITE, idempotentHint: true, title: 'Move a note' },
    },
    {
      name: 'trash_note',
      title: 'Move a note to Trash',
      description:
        'Move a note to Trash, as deleting it in the app does. The note keeps its content and history and leaves the folder tree; ' +
        'Ryan can restore it in the app, or you can with restore_note, for 30 days, after which it is deleted for good. ' +
        'History shows the change under your name. Calling it for a note already in Trash changes nothing (alreadyInTrash: true). ' +
        'An agent moves at most 100 notes to Trash a day. You cannot delete a note for good: only Ryan can, in the app.',
      inputSchema: object({ id: ID }, ['id']),
      write: true,
      ownIdCheck: true,
      annotations: {
        ...WRITE,
        destructiveHint: true,
        idempotentHint: true,
        title: 'Move a note to Trash',
      },
    },
    {
      name: 'restore_note',
      title: 'Restore a note from Trash',
      description:
        'Take a note out of Trash, back into the folder it was deleted from (the top level if that folder is gone). ' +
        'A folder-scoped token restores only notes deleted from a folder inside its own, into that folder. ' +
        'Calling it for a note not in Trash changes nothing (restored: false). Returns where the note is now.',
      inputSchema: object({ id: ID }, ['id']),
      write: true,
      ownIdCheck: true,
      annotations: { ...WRITE, idempotentHint: true, title: 'Restore a note from Trash' },
    },
    // --- folders (T42, A567) ---
    {
      name: 'create_folder',
      title: 'Create a folder',
      description:
        'Create a folder named name, inside parentId or parentPath (e.g. "Projects/Garden"; from list_folder), or at the top level if neither is given. ' +
        'If a folder of that name (ignoring case) is already there, returns it (created: false) instead of making a second, so retrying is safe. ' +
        'Make nested folders one level at a time. Returns its id.',
      inputSchema: object(
        {
          name: { type: 'string', maxLength: 200, description: 'The folder’s name; no /.' },
          parentId: { type: 'string', maxLength: 80, description: 'The parent folder’s id.' },
          parentPath: {
            type: 'string',
            maxLength: 1000,
            description: 'The parent folder’s path, e.g. "Projects/Garden" (instead of parentId).',
          },
        },
        ['name'],
      ),
      write: true,
      annotations: { ...WRITE, idempotentHint: true, title: 'Create a folder' },
    },
    {
      name: 'rename_folder',
      title: 'Rename a folder',
      description:
        'Rename a folder. Pass expectedName (the name you saw in list_folder) to be refused with folder_changed if someone renamed it since. Its notes and subfolders stay in it.',
      inputSchema: object(
        {
          folderId: FOLDER_ID,
          name: { type: 'string', maxLength: 200, description: 'The new name.' },
          expectedName: { type: 'string', maxLength: 200, description: 'The name you saw.' },
        },
        ['folderId', 'name'],
      ),
      write: true,
      annotations: { ...WRITE, idempotentHint: true, title: 'Rename a folder' },
    },
    {
      name: 'move_folder',
      title: 'Move or reorder a folder',
      description:
        'Move a folder (with everything in it) into parentId, or to the top level with parentId null; or reorder it among its siblings with before or after (a sibling folder’s id). ' +
        'Pass expectedParentId (where you saw it) to be refused with folder_moved if it moved since. A folder cannot move into itself or one of its subfolders.',
      inputSchema: object(
        {
          folderId: FOLDER_ID,
          parentId: {
            type: ['string', 'null'],
            description: 'The new parent; null for the top level.',
          },
          expectedParentId: {
            type: ['string', 'null'],
            description: 'The parent you saw it in; null for the top level.',
          },
          before: {
            type: 'string',
            maxLength: 80,
            description: 'Put it just before this sibling folder.',
          },
          after: {
            type: 'string',
            maxLength: 80,
            description: 'Put it just after this sibling folder.',
          },
        },
        ['folderId'],
      ),
      write: true,
      annotations: { ...WRITE, idempotentHint: true, title: 'Move or reorder a folder' },
    },
    {
      name: 'set_folder_sort',
      title: 'Set a folder’s sort order',
      description:
        'How a folder lists its notes and subfolders in the apps: manual (your order), alpha (A–Z) or modified (latest first). folderId null is the top level.',
      inputSchema: object(
        {
          folderId: {
            type: ['string', 'null'],
            description: 'The folder; null for the top level.',
          },
          sortMode: {
            type: 'string',
            enum: ['manual', 'alpha', 'modified'],
            description: 'The order.',
          },
        },
        ['folderId', 'sortMode'],
      ),
      write: true,
      annotations: { ...WRITE, idempotentHint: true, title: 'Set a folder’s sort order' },
    },
    {
      name: 'delete_folder',
      title: 'Delete a folder',
      description:
        'Delete a folder and its subfolders. No note is deleted: their notes move up to the folder’s parent. ' +
        'The folder goes to Trash, where Ryan can restore it with its subfolders and notes for 30 days, and the change is listed under your name in the app’s Agent activity, with an Undo. ' +
        'Deleting a folder that is already gone changes nothing (deleted: false). An agent deletes at most 25 folders a day.',
      inputSchema: object({ folderId: FOLDER_ID }, ['folderId']),
      write: true,
      annotations: {
        ...WRITE,
        destructiveHint: true,
        idempotentHint: true,
        title: 'Delete a folder',
      },
    },
    // --- versions, attachments, settings and tags (T42, A568) ---
    {
      name: 'save_version',
      title: 'Save a version',
      description:
        'Save the note as it is now as a version in its History. Versions are also saved automatically (after 5 minutes at rest, every 30 minutes of editing, and after each of your edits); ' +
        'with no change since the latest version, that one is returned (saved: false).',
      inputSchema: object({ id: ID }, ['id']),
      write: true,
      annotations: { ...WRITE, idempotentHint: true, title: 'Save a version' },
    },
    {
      name: 'restore_version',
      title: 'Restore a version',
      description:
        'Bring back a version’s content (versionId from get_history) as a new change; the versions after it stay in History, so this can be undone too. ' +
        'If the note already matches it, nothing changes (changed: false).',
      inputSchema: object({ id: ID, versionId: VERSION_ID }, ['id', 'versionId']),
      write: true,
      annotations: {
        ...WRITE,
        destructiveHint: true,
        idempotentHint: true,
        title: 'Restore a version',
      },
    },
    {
      name: 'revert_edit',
      title: 'Revert an edit',
      description:
        'Undo what one version changed (versionId from get_history), keeping every later edit: a three-way merge. ' +
        'Parts changed again since are listed in conflicts and left as they are. Reverting again changes nothing (changed: false).',
      inputSchema: object({ id: ID, versionId: VERSION_ID }, ['id', 'versionId']),
      write: true,
      annotations: {
        ...WRITE,
        destructiveHint: true,
        idempotentHint: true,
        title: 'Revert an edit',
      },
    },
    {
      name: 'attach_file',
      title: 'Attach a file or picture',
      description:
        'Store a file in Penmoss and add it at the end of a note (or of the section under heading): a picture (PNG, JPEG, GIF, WebP, AVIF) shows in the note, any other file is a link. ' +
        `Send the file in base64 as data, at most ${options.attachmentMaxBytes / 1024} KB (file_too_large), and at most 50 MB of new files a day. Attaching the same file to a note that already has it changes nothing (added: false).`,
      inputSchema: object(
        {
          id: ID,
          name: {
            type: 'string',
            maxLength: 200,
            description: 'The file’s name, e.g. "plan.pdf".',
          },
          data: { type: 'string', description: 'The file’s bytes in base64.' },
          alt: {
            type: 'string',
            maxLength: 500,
            description: 'Words for a picture (its alt text).',
          },
          heading: { type: 'string', maxLength: 500, description: 'Add it under this heading.' },
        },
        ['id', 'name', 'data'],
      ),
      write: true,
      annotations: { ...WRITE, idempotentHint: true, title: 'Attach a file or picture' },
    },
    {
      name: 'get_settings',
      title: 'Get settings',
      description:
        'Ryan’s synced settings: theme.id, theme.mode, timeZone, template.daily, template.weekly, capture.destination, note.fullWidth, and his custom themes (theme.custom.<id>). ' +
        'A setting not listed has its default.',
      inputSchema: object({}),
      write: false,
      annotations: { ...READ, title: 'Get settings' },
    },
    {
      name: 'set_settings',
      title: 'Change settings',
      description:
        'Change settings as the apps do: set maps each key to its new value (null brings back the default). ' +
        'Pass base, the values get_settings gave you (null for unset), to be refused with setting_changed if one changed since; without base, the current values are used. ' +
        'Each value is checked with the apps’ rules (invalid_setting names the key). Setting a value it already has changes nothing. ' +
        'You may change theme.id, theme.mode, timeZone, template.daily, template.weekly, note.fullWidth and custom themes; where quick captures go is Ryan’s (setting_not_allowed). ' +
        'Ryan can undo each change in the app’s Agent activity.',
      inputSchema: object(
        {
          set: {
            type: 'object',
            description: 'Keys and their new values, e.g. {"theme.mode": "dark"}.',
          },
          base: { type: 'object', description: 'The values you saw, for the same keys.' },
        },
        ['set'],
      ),
      write: true,
      workspaceWide: true,
      annotations: { ...WRITE, idempotentHint: true, title: 'Change settings' },
    },
    {
      name: 'rename_tag',
      title: 'Rename or merge a tag',
      description:
        'Rename a tag in every note that has it, nested tags included (projects/garden follows projects). ' +
        'Renaming to a tag that exists merges the two, so it needs merge: true (else tag_exists). ' +
        'Runs in the background, one version per note; Ryan can undo the whole rename in the app’s Agent activity (notes that had both tags keep the new one). ' +
        'Limits: at most 2,000 notes per rename, 10 renames a day per agent, 1,000 renamed notes a day for all agents together, and 2 agent renames waiting at a time (too_many_renames). Returns the notes it covers.',
      inputSchema: object(
        {
          from: { type: 'string', maxLength: 200, description: 'The tag now, without #.' },
          to: { type: 'string', maxLength: 200, description: 'Its new name, without #.' },
          merge: {
            type: 'boolean',
            description: 'Merge into a tag that exists already (required when it does).',
          },
        },
        ['from', 'to'],
      ),
      write: true,
      workspaceWide: true,
      annotations: { ...WRITE, destructiveHint: true, title: 'Rename or merge a tag' },
    },
    {
      name: 'tag_note',
      title: 'Tag a note',
      description:
        'Add and/or remove tags on a note (in its properties). Tags nest with /, e.g. "projects/garden". Returns the new baseVersion.',
      inputSchema: object(
        {
          id: ID,
          add: { ...TAGS, description: `Tags to add. ${TAGS.description}` },
          remove: { ...TAGS, description: 'Tags to remove.' },
          baseVersion: BASE_VERSION,
        },
        ['id'],
      ),
      write: true,
      annotations: { ...WRITE, idempotentHint: true, title: 'Tag a note' },
    },
  ];
}

// --- comment threads (T48, A775; T60, A1064) ---

const THREAD_NOTE: Schema = {
  type: 'string',
  maxLength: 80,
  description:
    'The note id (26 characters) or its short id (e.g. K7QD-9HTF2CXA), from search_notes, list_recent or list_folder.',
};
const THREAD: Schema = {
  type: 'string',
  maxLength: 40,
  description: 'The thread id, from list_comment_threads or a channel message (thread_id).',
};
const COMMENT_BODY: Schema = {
  type: 'string',
  maxLength: 20_000,
  description: 'The comment, in markdown.',
};
const THREAD_STATUS: Schema = {
  type: 'string',
  enum: ['open', 'resolved', 'all'],
  description: 'open (default), resolved, or all. Resolved threads are kept for good.',
};

/** The comment tools' names, in list order. */
export const COMMENT_TOOL_NAMES = [
  'list_comment_threads',
  'read_comment_thread',
  'create_comment_thread',
  'reply_to_comment_thread',
  'resolve_comment_thread',
] as const;

/**
 * The five comment tools (A775), as the remote server had them, now the local MCP server's
 * (`penmoss mcp`, A1064): the names and arguments are the server's; "sent to me" means sent to
 * this agent's writer, not to a token. Not in `toolDefinitions`, so a server lists them only
 * when it has them (the relay does not, D50).
 */
export function commentToolDefinitions(): readonly ToolDefinition[] {
  return [
    {
      name: 'list_comment_threads',
      title: 'List comment threads',
      description:
        'List comment threads: on one note (id), or across the notes. ' +
        'Ryan comments on a passage or a point of a note, often to ask you for something ("make this tighter"); you can reply, resolve, and start threads of your own (for example to review passages). ' +
        'status is open by default; resolved threads are kept for good. sentToMe lists the threads Ryan sent to you (to this agent, across notes). ' +
        'On one note threads on the note as a whole (kind "note") come first, then the rest in the order of the text, orphans last (their text was deleted; the quote stays). ' +
        'Each says where it is now (position: the text there, whether it still matchesQuote, the headings it is under, its block number; for an orphan, whether it was found again by its text and how). ' +
        'Each thread is a summary (its quote, state, how many comments and who wrote the last): read one with read_comment_thread for its comments.',
      inputSchema: object({
        id: { ...THREAD_NOTE, description: 'Only this note’s threads (all notes without it).' },
        status: THREAD_STATUS,
        sentToMe: {
          type: 'boolean',
          description: 'Only threads Ryan sent to you (across notes).',
        },
      }),
      write: false,
      annotations: { ...READ, title: 'List comment threads' },
    },
    {
      name: 'read_comment_thread',
      title: 'Read a comment thread',
      description:
        'Read one thread with all its comments, each naming its author (Ryan, or an agent). ' +
        'The quote is the text the thread is on (kind "note": the note as a whole, no quote). ' +
        'position is where it is now: text (a range’s text there now), matchesQuote, headings (outermost first), block (the nth block of text) and paragraph (that block’s text now); ' +
        'found is "anchor", or for a thread whose text was deleted "refound" (found again by its quote and the text around it; how: exact, exact-context, fuzzy or context, with similarity) or "lost". ' +
        'context is where it was when it was made: the text just before and after it, its headings, block and paragraph then. read_note gives the whole note. ' +
        'Reading a thread Ryan sent to you tells him you have seen it.',
      inputSchema: object({ id: THREAD_NOTE, threadId: THREAD }, ['id', 'threadId']),
      write: false,
      annotations: { ...READ, title: 'Read a comment thread' },
    },
    {
      name: 'create_comment_thread',
      title: 'Start a comment thread',
      description:
        'Start a thread on a note, attributed to you, e.g. a review comment on a passage. ' +
        'quote is a passage of the note as read_note shows it, leaving out formatting such as ** or ` (a link may be [[Bob]] or its label, Bob; a line break between blocks); ' +
        'occurrence picks the 1st, 2nd… place it occurs (default 1). Without a quote the thread is on the note as a whole. ' +
        'A comment never changes the note: edit with the edit tools, then reply in the thread.',
      inputSchema: object(
        {
          id: THREAD_NOTE,
          body: COMMENT_BODY,
          quote: { type: 'string', maxLength: 2000, description: 'The passage the thread is on.' },
          occurrence: {
            type: 'integer',
            minimum: 1,
            description: 'Which occurrence of quote (1st, 2nd…); default 1.',
          },
        },
        ['id', 'body'],
      ),
      write: true,
      annotations: { ...WRITE, title: 'Start a comment thread' },
    },
    {
      name: 'reply_to_comment_thread',
      title: 'Reply in a comment thread',
      description:
        'Reply in a thread, attributed to you: say what you did, or ask what you need. ' +
        'Ryan sees the reply in the note once it syncs. Change the note itself with the edit tools (replace_text, update_section…), which are attributed and revertible.',
      inputSchema: object({ id: THREAD_NOTE, threadId: THREAD, body: COMMENT_BODY }, [
        'id',
        'threadId',
        'body',
      ]),
      write: true,
      annotations: { ...WRITE, title: 'Reply in a comment thread' },
    },
    {
      name: 'resolve_comment_thread',
      title: 'Resolve a comment thread',
      description:
        'Mark a thread resolved once what it asks is done. It is kept, behind the Resolved filter, and Ryan can reopen it.',
      inputSchema: object({ id: THREAD_NOTE, threadId: THREAD }, ['id', 'threadId']),
      write: true,
      annotations: { ...WRITE, idempotentHint: true, title: 'Resolve a comment thread' },
    },
  ];
}
