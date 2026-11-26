/**
 * One local MCP server over several git notebooks (PEN-139, PEN-150): `penmoss mcp` with no
 * `--notebook`. The tools are the one-notebook server's, plus an optional `notebook` argument.
 *
 * - A call that names a note (its `id`, short or full) or a folder runs on the notebook that
 *   holds it: a short id names its notebook in its first 4 characters, and a full id or a folder
 *   id is looked up among the served notebooks, on this machine.
 * - A read that names neither spans every notebook (`SPANS`), and each result names its notebook.
 * - A write that names neither needs `notebook` when more than one notebook is served.
 * - Nothing moves between notebooks: a note or folder moved into another notebook's folder is
 *   refused (`cross_notebook`).
 *
 * The router runs each tool exactly as the one-notebook server does (`RunOn`), so a tool's
 * behaviour on one notebook never differs between the two servers.
 */
import type { AgentSession } from '../sessions';
import { parseNoteRef } from '@penmoss/core/note-ref';
import { reciprocalRankFusion } from '@penmoss/core/search';
import type { ToolDefinition } from './tools';
import type { LocalNotebook } from './notebook';

/** A notebook the server serves: its name, as the app shows it, and its short ids' first part. */
export interface ServedNotebook {
  readonly name: string;
  /** The 4 characters its short ids start with (PEN-69); null before its first sync. */
  readonly tag: string | null;
}

/** The notebook is held by another call or process for longer than the call would wait. */
export class NotebookBusy extends Error {
  constructor(readonly notebook: string) {
    super(`${notebook} is busy syncing`);
    this.name = 'NotebookBusy';
  }
}

/** How the server reaches several notebooks: each under its own clone's lock. */
export interface NotebookSet {
  /** The notebooks served now (re-read by the host when its registry changes). */
  notebooks(): Promise<readonly ServedNotebook[]> | readonly ServedNotebook[];
  /**
   * Runs `run` on one notebook under its clone's lock, saved (and synced) after writes. With
   * `waitMs`, a lock not free in time throws `NotebookBusy` instead of waiting longer.
   */
  use<T>(
    notebook: string,
    write: boolean,
    run: (notebook: LocalNotebook) => Promise<T> | T,
    options?: { readonly waitMs?: number },
  ): Promise<T>;
}

type Args = Record<string, unknown>;
type Outcome =
  | { readonly data: Record<string, unknown>; readonly text?: readonly string[] }
  | {
      readonly error: string;
      /** How it failed, for usage analytics (PEN-137): `failed` when not said. */
      readonly result?: 'invalid' | 'notFound' | 'conflict' | 'failed';
    };

/** Runs one tool on one notebook, as the one-notebook server would. */
export type RunOn = (
  notebook: string,
  tool: ToolDefinition,
  args: Args,
  waitMs?: number,
  /** Who is calling (PEN-152): a write names them. */
  session?: AgentSession | null,
) => Promise<Outcome>;

/** How long a read across every notebook waits for one notebook before leaving it out. */
const SPAN_WAIT_MS = 5_000;

/** Tools whose `id` names a note: they run on its notebook. */
const NOTE_TOOLS: ReadonlySet<string> = new Set([
  'read_note',
  'get_backlinks',
  'get_history',
  'append_to_note',
  'update_section',
  'replace_text',
  'set_properties',
  'tag_note',
  'move_note',
  'trash_note',
  'restore_note',
  'save_version',
  'restore_version',
  'revert_edit',
  'attach_file',
  'create_comment_thread',
  'read_comment_thread',
  'reply_to_comment_thread',
  'resolve_comment_thread',
  // With an id; without one it spans.
  'list_comment_threads',
]);

/** Tools that run on the notebook of the folder this argument names, when it names one. */
const FOLDER_TOOLS: Readonly<Record<string, string>> = {
  list_folder: 'folderId',
  search_notes: 'folderId',
  create_note: 'folderId',
  create_folder: 'parentId',
  rename_folder: 'folderId',
  move_folder: 'folderId',
  set_folder_sort: 'folderId',
  delete_folder: 'folderId',
};

/** Other folders a call names: they must be in the notebook it runs on (`cross_notebook`). */
const SAME_NOTEBOOK_FOLDERS: Readonly<Record<string, readonly string[]>> = {
  move_note: ['folderId'],
  move_folder: ['parentId', 'before', 'after'],
};

/** Reads that cover every notebook when they name no note, folder or notebook. */
const SPANS: ReadonlySet<string> = new Set([
  'search_notes',
  'list_recent',
  'list_tags',
  'describe_tags',
  'list_comment_threads',
  'get_settings',
  'list_folder',
]);

/** What `notebook` is, in each tool's schema. */
const NOTEBOOK_ARGUMENT =
  'The notebook, by its name as Penmoss shows it or by the 4 characters its short ids start with. ' +
  'Leave it out when you name a note or folder by its id: the id finds its notebook. ' +
  'Searches and lists cover every notebook without it. A new note, folder or daily note needs it when more than one notebook is served.';

/** A tool as the several-notebook server lists it: its own words, and `notebook`. */
export function withNotebookArgument(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    description: tool.description
      .replace(
        'Search the notes of this git notebook',
        'Search the notes of every notebook here (pass notebook for one)',
      )
      .replace(/\b[Tt]his git notebook(’s)?/g, (_match, own: string | undefined) =>
        own ? 'the notebook’s' : 'the notebook',
      ),
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        notebook: { type: 'string', description: NOTEBOOK_ARGUMENT },
      },
    },
  };
}

/** The served notebooks, for a refusal. */
function listing(served: readonly ServedNotebook[]): string {
  const names = served.map((each) =>
    each.tag ? `“${each.name}” (short ids ${each.tag}-…)` : `“${each.name}”`,
  );
  return `The notebooks here: ${names.join(', ')}.`;
}

/** The notebook `asked` names: its name exactly, then ignoring case, or its tag. */
function pickNotebook(asked: string, served: readonly ServedNotebook[]): ServedNotebook | null {
  const wanted = asked.trim();
  return (
    served.find((each) => each.name === wanted) ??
    served.find((each) => each.name.toLowerCase() === wanted.toLowerCase()) ??
    served.find((each) => each.tag !== null && each.tag === wanted.toUpperCase()) ??
    null
  );
}

/** The notebook's name on each item of a list. */
function named(items: unknown, notebook: string): unknown {
  if (!Array.isArray(items)) return items;
  return items.map((item: unknown) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? { notebook, ...(item as Record<string, unknown>) }
      : item,
  );
}

/** An ISO time to sort by, newest last: '' for none. */
const stamp = (value: unknown): string => (typeof value === 'string' ? value : '');

/** An outcome of one notebook, saying which. */
function onNotebook(outcome: Outcome, notebook: string): Outcome {
  if ('error' in outcome) return outcome;
  const data = { notebook, ...outcome.data };
  if (!outcome.text) return { data };
  const [first, ...rest] = outcome.text;
  try {
    const meta = JSON.parse(first ?? '') as unknown;
    if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
      return { data, text: [JSON.stringify({ notebook, ...meta }), ...rest] };
    }
  } catch {
    // Not JSON: the text stays as it is.
  }
  return { data, text: outcome.text };
}

/** Where a call's ids lead: the notebooks that hold them, or a refusal. */
type Located =
  | { readonly kind: 'none' }
  | { readonly kind: 'some'; readonly candidates: readonly ServedNotebook[]; readonly what: string }
  | { readonly kind: 'error'; readonly error: string };

interface Answer {
  readonly notebook: ServedNotebook;
  readonly outcome: Outcome;
}

export class NotebookRouter {
  constructor(
    private readonly set: NotebookSet,
    private readonly runOn: RunOn,
  ) {}

  async notebooks(): Promise<readonly ServedNotebook[]> {
    return [...(await this.set.notebooks())];
  }

  async call(
    tool: ToolDefinition,
    checked: Args,
    session: AgentSession | null = null,
  ): Promise<Outcome> {
    const served = await this.notebooks();
    if (served.length === 0) {
      return {
        error:
          'No git notebook on this machine has an agent copy to serve. Open the notebook in Penmoss for Mac, which makes one, or add one with penmoss notebook add --agent.',
      };
    }
    const { notebook: asked, ...args } = checked;
    let wanted: ServedNotebook | null = null;
    if (typeof asked === 'string') {
      wanted = pickNotebook(asked, served);
      if (!wanted) {
        return {
          error: `No notebook here is called “${asked}”. ${listing(served)}`,
          result: 'notFound',
        };
      }
    }
    const located = await this.locate(tool.name, args, served);
    if (located.kind === 'error') return { error: located.error, result: 'notFound' };
    let target: ServedNotebook | null = wanted;
    if (located.kind === 'some') {
      const { candidates, what } = located;
      if (wanted) {
        const asked = wanted.name;
        if (!candidates.some((each) => each.name === asked)) {
          return {
            error: `${what} is in the notebook “${candidates[0]!.name}”, not “${wanted.name}”. Leave out notebook, or pass "${candidates[0]!.name}".`,
            result: 'invalid',
          };
        }
      } else if (candidates.length > 1) {
        return {
          error: `${what} is in more than one notebook (${candidates.map((each) => `“${each.name}”`).join(', ')}): pass notebook to say which.`,
          result: 'invalid',
        };
      } else {
        target = candidates[0]!;
      }
    }
    if (target) {
      const refused = await this.crossNotebook(tool.name, args, target, served);
      if (refused) return { error: refused, result: 'invalid' };
      return this.one(target, tool, args, session);
    }
    if (SPANS.has(tool.name)) return this.span(tool, args, served);
    if (served.length === 1) return this.one(served[0]!, tool, args, session);
    return {
      error: `${tool.name} needs notebook here, since this server serves ${served.length} notebooks: pass the notebook's name. ${listing(served)}`,
      result: 'invalid',
    };
  }

  /** The notebooks holding what the call names, if it names a note or a folder. */
  private async locate(
    name: string,
    args: Args,
    served: readonly ServedNotebook[],
  ): Promise<Located> {
    const id = args['id'];
    if (NOTE_TOOLS.has(name) && typeof id === 'string') return this.byNote(id, served);
    const folderArg = FOLDER_TOOLS[name];
    const folder = folderArg === undefined ? undefined : args[folderArg];
    if (typeof folder === 'string') {
      const candidates = await this.holding(served, (notebook) => notebook.holdsFolder(folder));
      if (candidates.length === 0) {
        return {
          kind: 'error',
          error: `No folder ${folder} in any notebook here. Find folder ids with list_folder. ${listing(served)}`,
        };
      }
      return { kind: 'some', candidates, what: `The folder ${folder}` };
    }
    return { kind: 'none' };
  }

  private async byNote(ref: string, served: readonly ServedNotebook[]): Promise<Located> {
    const parsed = parseNoteRef(ref);
    if (parsed.kind === 'short') {
      const owner = served.find((each) => each.tag === parsed.notebook);
      if (!owner) {
        return {
          kind: 'error',
          error: `${ref.trim()} is a note of a notebook this server does not serve (its short ids start with ${parsed.notebook}). ${listing(served)}`,
        };
      }
      return { kind: 'some', candidates: [owner], what: `The note ${ref.trim()}` };
    }
    const candidates = await this.holding(served, (notebook) => notebook.holdsNote(parsed.id));
    if (candidates.length === 0) {
      return {
        kind: 'error',
        error: `No note with id ${ref.trim()} in any notebook here. Find ids with search_notes, list_recent or list_folder.`,
      };
    }
    return { kind: 'some', candidates, what: `The note ${ref.trim()}` };
  }

  /** The served notebooks for which `holds` is true, looked at on this machine. */
  private async holding(
    served: readonly ServedNotebook[],
    holds: (notebook: LocalNotebook) => boolean,
  ): Promise<ServedNotebook[]> {
    const found = await Promise.all(
      served.map(async (each) =>
        (await this.set.use(each.name, false, holds).catch(() => false)) ? each : null,
      ),
    );
    return found.filter((each): each is ServedNotebook => each !== null);
  }

  /** A refusal when the call moves something into another notebook's folder. */
  private async crossNotebook(
    name: string,
    args: Args,
    target: ServedNotebook,
    served: readonly ServedNotebook[],
  ): Promise<string | null> {
    for (const arg of SAME_NOTEBOOK_FOLDERS[name] ?? []) {
      const folder = args[arg];
      if (typeof folder !== 'string') continue;
      const here = await this.set
        .use(target.name, false, (notebook) => notebook.holdsFolder(folder))
        .catch(() => false);
      if (here) continue;
      const others = await this.holding(
        served.filter((each) => each.name !== target.name),
        (notebook) => notebook.holdsFolder(folder),
      );
      if (others.length === 0) continue; // Not found anywhere: the tool says so.
      const moving = name === 'move_note' ? 'note' : 'folder';
      return `${arg} ${folder} is a folder of the notebook “${others[0]!.name}”, and this ${moving} is in “${target.name}” (cross_notebook). Nothing moves between notebooks: make the ${moving} in “${others[0]!.name}” and trash this one.`;
    }
    return null;
  }

  private async one(
    target: ServedNotebook,
    tool: ToolDefinition,
    args: Args,
    session: AgentSession | null,
  ): Promise<Outcome> {
    try {
      return onNotebook(await this.runOn(target.name, tool, args, undefined, session), target.name);
    } catch (error) {
      if (error instanceof NotebookBusy) {
        return { error: `“${target.name}” is busy syncing. Try again in a moment.` };
      }
      throw error;
    }
  }

  /** A read on every notebook, its answers merged. */
  private async span(
    tool: ToolDefinition,
    args: Args,
    served: readonly ServedNotebook[],
  ): Promise<Outcome> {
    const answers = await Promise.all(
      served.map(async (notebook): Promise<Answer | { readonly busy: ServedNotebook }> => {
        try {
          return { notebook, outcome: await this.runOn(notebook.name, tool, args, SPAN_WAIT_MS) };
        } catch (error) {
          if (error instanceof NotebookBusy) return { busy: notebook };
          throw error;
        }
      }),
    );
    const done = answers.filter((each): each is Answer => 'outcome' in each);
    const ok = done.filter((each) => !('error' in each.outcome));
    const failed = done.filter((each) => 'error' in each.outcome);
    const busy = answers.flatMap((each) => ('busy' in each ? [each.busy] : []));

    if (tool.name === 'list_folder' && typeof args['path'] === 'string') {
      // A path names a folder by its names: only the notebooks that have it answer.
      if (ok.length === 1) return onNotebook(ok[0]!.outcome, ok[0]!.notebook.name);
      if (ok.length > 1) {
        return {
          error: `${String(args['path'])} is a folder in more than one notebook (${ok.map((each) => `“${each.notebook.name}”`).join(', ')}): pass notebook to say which.`,
          result: 'invalid',
        };
      }
    }
    if (ok.length === 0) {
      if (failed.length > 0) return failed[0]!.outcome;
      return { error: 'Every notebook is busy syncing. Try again in a moment.' };
    }
    const merged = this.merge(tool.name, args, ok, served);
    const skipped = [
      ...busy.map((notebook) => ({ notebook: notebook.name, reason: 'busy syncing' })),
      ...failed.map((each) => ({
        notebook: each.notebook.name,
        reason: 'error' in each.outcome ? each.outcome.error : '',
      })),
    ];
    if (skipped.length === 0) return merged;
    if ('error' in merged) return merged;
    return { ...merged, data: { ...merged.data, skipped } };
  }

  private merge(
    name: string,
    args: Args,
    ok: readonly Answer[],
    served: readonly ServedNotebook[],
  ): Outcome {
    const data = (answer: Answer) => ('data' in answer.outcome ? answer.outcome.data : {});
    const list = (answer: Answer, key: string) => {
      const value = data(answer)[key];
      return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
    };
    switch (name) {
      case 'search_notes': {
        const lists = ok.map((answer) => list(answer, 'results'));
        const fused = reciprocalRankFusion(
          lists.map((results, which) => results.map((hit) => `${which}\u0000${String(hit['id'])}`)),
        );
        const limit = (args['limit'] as number | undefined) ?? 10;
        const results = fused.slice(0, limit).map((entry) => {
          const which = Number(entry.id.slice(0, entry.id.indexOf('\u0000')));
          const id = entry.id.slice(entry.id.indexOf('\u0000') + 1);
          const hit = lists[which]!.find((each) => String(each['id']) === id)!;
          return { notebook: ok[which]!.notebook.name, ...hit };
        });
        const coverage = ok.flatMap((answer) => {
          const value = data(answer)['coverage'];
          return value === undefined
            ? []
            : [{ notebook: answer.notebook.name, ...(value as object) }];
        });
        const notices = ok.flatMap((answer) => {
          const value = data(answer)['notice'];
          return typeof value === 'string' ? [`${answer.notebook.name}: ${value}`] : [];
        });
        return {
          data: {
            mode: data(ok[0]!)['mode'],
            results,
            ...(coverage.length > 0 ? { coverage } : {}),
            ...(notices.length > 0 ? { notice: notices.join(' ') } : {}),
          },
        };
      }
      case 'list_recent': {
        const limit = (args['limit'] as number | undefined) ?? 20;
        const notes = ok
          .flatMap((answer) => named(list(answer, 'notes'), answer.notebook.name) as Args[])
          .sort((a, b) => stamp(b['updatedAt']).localeCompare(stamp(a['updatedAt'])))
          .slice(0, limit);
        return { data: { notes } };
      }
      case 'list_tags': {
        if (args['tag'] !== undefined) break;
        const tags = new Map<
          string,
          { name: string; notes: number; description?: string; notebooks: string[] }
        >();
        for (const answer of ok) {
          for (const tag of list(answer, 'tags')) {
            const tagName = String(tag['name']);
            const entry = tags.get(tagName) ?? { name: tagName, notes: 0, notebooks: [] };
            entry.notes += typeof tag['notes'] === 'number' ? tag['notes'] : 0;
            if (entry.description === undefined && typeof tag['description'] === 'string') {
              entry.description = tag['description'];
            }
            entry.notebooks.push(answer.notebook.name);
            tags.set(tagName, entry);
          }
        }
        return {
          data: {
            tags: [...tags.values()].sort(
              (a, b) => b.notes - a.notes || a.name.localeCompare(b.name),
            ),
          },
        };
      }
      case 'list_comment_threads': {
        const threads = ok
          .flatMap((answer) => named(list(answer, 'threads'), answer.notebook.name) as Args[])
          .sort((a, b) => stamp(b['updated']).localeCompare(stamp(a['updated'])));
        const merged = { status: data(ok[0]!)['status'], threads };
        const first = ok[0]!.outcome;
        const hint = 'text' in first ? first.text?.slice(1) : undefined;
        return { data: merged, text: [JSON.stringify(merged), ...(hint ?? [])] };
      }
      case 'get_settings':
        return {
          data: {
            notebooks: ok.map((answer) => ({ notebook: answer.notebook.name, ...data(answer) })),
          },
        };
      default:
        break;
    }
    // Lists of each notebook joined, each item naming its notebook; anything else the first's.
    const merged: Record<string, unknown> = {};
    for (const answer of ok) {
      for (const [key, value] of Object.entries(data(answer))) {
        if (Array.isArray(value)) {
          const before: unknown = merged[key];
          merged[key] = [
            ...(Array.isArray(before) ? (before as unknown[]) : []),
            ...(named(value, answer.notebook.name) as unknown[]),
          ];
        } else if (!(key in merged)) {
          merged[key] = value;
        }
      }
    }
    if (name === 'list_folder') {
      merged['notebooks'] = served.map((each) => ({ name: each.name, tag: each.tag }));
    }
    return { data: merged };
  }
}

/** What `initialize` tells an agent about the notebooks it reaches. */
export function notebooksInstructions(served: readonly ServedNotebook[], meaning: boolean): string {
  const names = served.length
    ? served
        .map((each) => (each.tag ? `${each.name} (short ids ${each.tag}-…)` : each.name))
        .join(', ')
    : 'none yet';
  return `These are Ryan's git notebooks, served together: ${names}. Each notebook's notes are kept in its own git repository. Markdown with a title, tags (nested with /), headings, [[wikilinks]] between notes, folders, and a daily and weekly journal.
- A note's id or short id finds its notebook, so tools that take one need no notebook argument. A folder id finds its notebook too.
- search_notes, list_recent, list_folder, list_tags, describe_tags, list_comment_threads and get_settings cover every notebook unless you pass notebook; each result names its notebook.
- With more than one notebook, pass notebook (its name) to create_note without a folderId, get_daily_note, create_folder without a parentId, set_settings, rename_tag, and set_folder_sort for the top level.
- Notes and folders never move between notebooks: to move one, make it in the other notebook and trash it here.
- Find notes with search_notes (${meaning ? 'by their words and their meaning: describe what you are looking for in your own words' : 'words only here'}), list_recent, list_folder or list_tags; read one with read_note.
- Many notes have a description: a sentence or two on what the note is about, written by Ryan or by AI Descriptions. search_notes, list_recent, list_folder and get_backlinks give it, and read_note gives the description of each note it links to (links). Read descriptions to choose which notes to open before reading their whole text.
- Ryan describes what some tags mean: describe_tags gives each tag's description, and its parents'. Read them before choosing tags for a note or to know what a tag is for.
- Every read returns a baseVersion. Pass it to your next edit of that note; update_section and replace_text require it. Each edit returns the next baseVersion.
- An edit refused with a conflict means the part changed since you read it: call read_note again and redo the edit on the current text. Never retry blindly.
- For today's journal call get_daily_note with the notebook (it creates the day's note from that notebook's template, in its time zone), then append_to_note, optionally under one of its headings.
- Your edits are committed to each notebook's repository under its agent copy's writer a minute after they settle, and when this server stops.
- trash_note moves a note to Trash; nothing deletes a note for good.
- Ryan comments on passages of notes, often to ask you for something: list_comment_threads (sentToMe: true for the threads he sent to you), read_comment_thread, then do it with the edit tools and say so with reply_to_comment_thread, or resolve_comment_thread. create_comment_thread starts a thread of your own on a quoted passage. Comments are committed and pushed like edits.`;
}
