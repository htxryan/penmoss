/**
 * A git notebook's notes server, inside the engine page (T50 G7, A874): the app's Kotlin talks
 * to it exactly as it talks to the Penmoss API, through `HttpPenmossApi` with a local origin
 * (`https://git.invalid/<localId>/`) whose requests never leave the phone: an OkHttp interceptor
 * hands each one to this page. So Room, the sync engine, the note screens, the Senders and the
 * editor work unchanged for a git notebook, and Kotlin still never reads Yjs (A11).
 *
 * - `/sync/tree`, `/sync/changes` and `/sync/batch` answer from the engine's replica: the tree
 *   from the WorkspaceDoc, each note's index row from its doc, and its content as Yjs updates.
 *   Uploads are taken in as local changes (`adopt`, A851), saved before the answer, and pushed
 *   once edits settle. Each note's change clock is its replica `rev` seen here, so whatever a
 *   sync brought (a push that failed after its fetch included) reaches the phone at its next
 *   pass, after a crash too: the revs are saved with the replica (A859's delivery rule).
 * - `/api/*` answers as the server does, through `LocalNotebook` (the CLI's local notes API),
 *   with the shapes the phone reads. Delete for good and History's restore ask the phone's
 *   owner first, in the app's own words (A877).
 *
 * The epoch (A5) is the engine store's own: a store made afresh (its data lost) has a new one,
 * so every copy on the phone is replaced from git instead of being merged into nothing.
 */
import {
  isPurged,
  isUpdate,
  markPurged,
  markRecoveredFrom,
  purgedIds,
  unmarkPurged,
  type GitNotebookEngine,
  type NotebookOps,
} from '@penmoss/git-notebook';
import { LocalError, localFetch, type LocalNotebook } from '@penmoss/git-notebook/local';
import { effectiveParents, keyBetween, compareOrder } from '@penmoss/core/workspace';
import { textHash } from '@penmoss/core/mirror';
import { isTimeZone, journalFolderId, todayIn } from '@penmoss/core/periodic';
import {
  initNote,
  isDeleted,
  isoWithOffset,
  readNoteNotebook,
  readTitle,
  readTrashInfo,
  setDeleted,
} from '@penmoss/sync-client/note';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { isActive, offeredSessions, readAgentSessions } from '@penmoss/sync-client/agent-sessions';
import { ulid } from '@penmoss/core/ids';
import {
  createFolder,
  fallbackFolder,
  moveNote,
  readFolderTrash,
  readSettings,
  readWorkspace,
  registerNote,
  setSetting,
} from '@penmoss/sync-client/workspace';
import { parseMarkdown } from '@penmoss/core';
import { appendCapture, captureTime, splitCapture } from '@penmoss/editor/capture';
import { mirrorMarkdown, readNoteState } from '@penmoss/editor/markdown';
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from '@y/y';

/** What the interceptor hands over: the path after the notebook's origin, with its query. */
export interface LocalRequest {
  readonly method: string;
  /** `/sync/tree?since=…`, `/api/notes/<id>/move`. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
}

export interface LocalReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/** What the server needs from the engine host and the app. */
export interface ServerHooks {
  /** A change was made here: the replica is saved before the answer, and pushed once settled. */
  changed(): Promise<void>;
  /**
   * Delete for good (A828, A855): the app's owner check, naming the note from the branch. Throws
   * (`not_confirmed`) when the person did not confirm.
   */
  confirmPurge(noteId: string): Promise<void>;
  /** History's restore or revert (A877): the owner check first, as for Delete for good. */
  confirmRestore(noteId: string, version: number, revert: boolean): Promise<void>;
  /** The device's name, as Trash says who moved a note there. */
  readonly label: string;
  readonly now: () => number;
  /**
   * A sync has landed since the page opened (T60, A1077): the WorkspaceDoc's sessions are as
   * fresh as the repository's, so a session missing from them is gone. False when not given.
   */
  readonly synced?: () => boolean;
}

/** The server's bookkeeping, saved with the engine's store (`android:server`). */
export interface ServerState {
  /** The engine store's epoch (A5): new when the store is made afresh. */
  readonly epoch: string;
  /** The latest clock given to a change. */
  readonly clock: number;
  /** Each note's replica `rev` as last listed, and the clock it was listed at. */
  readonly notes: Readonly<Record<string, { readonly rev: number; readonly clock: number }>>;
  /** Notes deleted for good, as tombstones (`purged` rows), by the clock they were listed at. */
  readonly gone: Readonly<Record<string, number>>;
  /** Captures taken in (T34): capture id → note id, so a retry adds nothing. */
  readonly captures: Readonly<Record<string, { readonly noteId: string; readonly at: number }>>;
}

export const SERVER_STATE_KEY = 'android:server';

/** Rows per `/sync/changes` page (the server's page size). */
export const CHANGES_PAGE = 200;
/** Notes per `/sync/batch` request (the server's limit). */
export const BATCH_MAX_NOTES = 50;
/** Uploads per note in one request (the server's `BATCH_MAX_UPDATES`). */
export const BATCH_MAX_UPDATES = 200;
/** A note's text in a batch reply, as the server caps it (T40 P6). */
export const MAX_TEXT_BYTES = 256 * 1024;
/** Captures remembered for retries. */
const MAX_CAPTURES = 2_000;
const EXCERPT_CHARS = 200;
const NOTE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const FOLDER_ID = /^[0-9A-Z]{26}$/;
/** A body's text field, or empty when it is not text. */
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

const CAPTURE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A capture's Inbox note id: the capture's own when it is a ULID, else one made from its SHA-256. */
export async function captureNoteId(captureId: string): Promise<string> {
  if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(captureId)) return captureId;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`penmoss-capture:${captureId}`)),
  );
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += CROCKFORD[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === 26) break;
  }
  // A ULID's first character is 0–7 (48 bits of time).
  return CROCKFORD[CROCKFORD.indexOf(out[0]!) & 7] + out.slice(1);
}
const SHA256 = /^[0-9a-f]{64}$/;
const INBOX = 'Inbox';

/**
 * Where a git notebook keeps each device's settings (A827, A1014): the WorkspaceDoc's settings
 * under the user id `device`, as the Mac's and the web's `GIT_DEVICE_SETTINGS`; the notebook's own
 * (`timeZone`, `template.*`) are under `notebook`.
 */
export const DEVICE_SETTINGS = 'device';
/** The app's own route for them: only Penmoss's Kotlin reaches this server (never an agent). */
export const DEVICE_SETTINGS_PATH = '/android/device-settings';
/**
 * The agent sessions the WorkspaceDoc lists (T60, A1060, A1076), for Send to… and the gone check:
 * the app's own route, as the device settings'.
 */
export const AGENT_SESSIONS_PATH = '/android/agent-sessions';
/** A setting of the notebook's own, never a device's (the web's `isNotebookSetting`). */
export const isNotebookSetting = (key: string): boolean =>
  key === 'timeZone' || key.startsWith('template.');
/** At most this many settings in one change, as the server's `PUT /api/settings`. */
const DEVICE_SETTINGS_PER_CHANGE = 50;
const SETTING_KEY = /^[A-Za-z0-9._-]{1,200}$/;

export const EPOCH_MISMATCH = 'Epoch mismatch';
export const GONE = 'Gone';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Body = Record<string, unknown>;

const json = (status: number, value: unknown): LocalReply => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: encoder.encode(JSON.stringify(value)),
});

const empty = (status: number): LocalReply => ({ status, headers: {}, body: new Uint8Array() });

const refusal = (status: number, code: string, message: string, extra: Body = {}) =>
  json(status, { error: { code, message, ...extra } });

export function newEpoch(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `git-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function emptyState(epoch: string = newEpoch()): ServerState {
  return { epoch, clock: 0, notes: {}, gone: {}, captures: {} };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** At most `max` UTF-8 bytes of `text`, cut at a character. */
function capBytes(text: string, max: number): string {
  if (text.length * 3 <= max) return text;
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= max) return text;
  let cut = max;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return decoder.decode(bytes.subarray(0, cut));
}

const excerptOf = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);

/** What became of one of Room's old copies (A886). */
export type RecoverAnswer =
  | { readonly status: 'later' }
  | { readonly status: 'done' }
  | { readonly status: 'recovered'; readonly id: string; readonly title: string };

export class LocalServer {
  private state: ServerState;
  private readonly rest: ReturnType<typeof localFetch>;
  /**
   * Room's copies from a store Android cleared (A886) wait here: an exchange of one from another
   * epoch is deferred, so Room keeps it, until the app has had the page bring back what git
   * lacks of it ([releaseOldCopy]) or there are none left ([endOldCopies]).
   */
  private holding = false;
  private readonly released = new Set<string>();

  constructor(
    private readonly engine: GitNotebookEngine,
    private readonly ops: NotebookOps,
    private readonly notebook: LocalNotebook,
    private readonly hooks: ServerHooks,
    state: ServerState,
    /** Saves the bookkeeping (beside the engine's store). */
    private readonly saveState: (state: ServerState) => Promise<void>,
  ) {
    this.state = state;
    this.rest = localFetch(notebook);
  }

  get epoch(): string {
    return this.state.epoch;
  }

  /** At open: Room holds notes of these epochs; any but this store's are held (A886). */
  holdOldCopies(epochs: readonly string[]): void {
    this.holding = epochs.some((epoch) => epoch !== this.state.epoch);
  }

  /** The app is done with Room's old copy of `noteId`: Room's exchange of it goes ahead. */
  releaseOldCopy(noteId: string): void {
    this.released.add(noteId);
  }

  /** No old copy waits any more. */
  endOldCopies(): void {
    this.holding = false;
    this.released.clear();
  }

  get current(): ServerState {
    return this.state;
  }

  private get workspace(): Y.Doc {
    return this.engine.replica.workspace;
  }

  /** Answers one request; never throws (a failure is a 500 with what went wrong). */
  async handle(request: LocalRequest): Promise<LocalReply> {
    const method = request.method.toUpperCase();
    const url = new URL(request.path, 'https://git.invalid');
    try {
      let body: Body = {};
      const raw = request.body;
      const binary = url.pathname.startsWith('/api/attachments/');
      if (!binary && raw && raw.byteLength > 0) {
        const parsed: unknown = JSON.parse(decoder.decode(raw));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return refusal(400, 'invalid_request', 'The request body must be a JSON object');
        }
        body = parsed as Body;
      }
      const reply = await this.route(method, url, body, request);
      return reply;
    } catch (error) {
      if (error instanceof LocalError) {
        return refusal(error.status, error.code, error.message, error.details ?? {});
      }
      if (error instanceof SyntaxError)
        return refusal(400, 'invalid_request', 'The body is not JSON');
      const coded = error as { status?: unknown; code?: unknown; message?: unknown };
      if (typeof coded?.status === 'number' && typeof coded.code === 'string') {
        return refusal(
          coded.status,
          coded.code,
          typeof coded.message === 'string' ? coded.message : coded.code,
        );
      }
      return refusal(500, 'error', error instanceof Error ? error.message : String(error));
    }
  }

  /** Runs a change alone (never beside a sync's build) and saves it before answering. */
  private async write<T>(change: () => T | Promise<T>): Promise<T> {
    return this.engine.exclusive(async () => {
      const result = await change();
      await this.hooks.changed();
      return result;
    });
  }

  /**
   * Every session the WorkspaceDoc lists (A1076): Send to…'s (`offered`, seen this week) first,
   * running ones (`active`) before them, then the rest, as `offeredSessions` orders them.
   */
  private agentSessions() {
    const now = this.hooks.now();
    const offered = offeredSessions(this.workspace, now);
    const keys = new Set(offered.map((each) => each.key));
    const rest = readAgentSessions(this.workspace).filter((each) => !keys.has(each.key));
    return {
      now,
      synced: this.hooks.synced?.() ?? false,
      sessions: [...offered, ...rest].map((each) => ({
        key: each.key,
        writer: each.writer,
        label: each.label,
        name: each.name,
        host: each.host,
        startedAt: each.startedAt,
        lastSeen: each.lastSeen,
        active: isActive(each, now),
        offered: keys.has(each.key),
      })),
    };
  }

  private async route(
    method: string,
    url: URL,
    body: Body,
    request: LocalRequest,
  ): Promise<LocalReply> {
    const path = url.pathname;
    const query = url.searchParams;
    if (path === '/sync/tree' && method === 'GET') return json(200, this.tree(query.get('since')));
    if (path === '/sync/changes' && method === 'GET') {
      const since = Number(query.get('since') ?? 0);
      if (!Number.isSafeInteger(since) || since < 0) {
        return refusal(400, 'invalid_request', 'since must be a clock value');
      }
      return json(200, await this.changes(since));
    }
    if (path === '/sync/batch' && method === 'POST') return this.batch(body);
    if (path === '/api/capture' && method === 'POST') return json(200, await this.capture(body));
    if (path === '/api/daily' && method === 'POST') {
      const reply = await this.write(() =>
        this.notebook.daily({
          period: body['period'] === 'weekly' ? 'weekly' : 'daily',
          ...(typeof body['date'] === 'string' ? { date: body['date'] } : {}),
        }),
      );
      return json(200, { id: reply.id, created: reply.created });
    }
    if (path === '/api/search' && method === 'GET') return json(200, await this.search(query));
    if (path === '/api/trash' && method === 'GET') return json(200, { notes: this.trashList() });
    if (path === '/api/folders/trash' && method === 'GET') {
      return json(200, { folders: this.folderTrash() });
    }
    if (path === '/api/folders' && method === 'POST') return this.createFolder(body);
    if (path === '/api/folders/root' && method === 'PATCH') {
      if (body['notebookName'] !== undefined) {
        return refusal(404, 'not_available', 'A git notebook has no default notebook to name');
      }
      return json(
        200,
        await this.write(() => this.notebook.patchRoot(sortModeOf(body['sortMode']))),
      );
    }
    const folderRestore = /^\/api\/folders\/([0-9A-Z]{26})\/restore$/.exec(path);
    if (folderRestore && method === 'POST')
      return json(200, await this.restoreFolder(folderRestore[1]!));
    const folder = /^\/api\/folders\/([0-9A-Z]{26})$/.exec(path);
    if (folder && method === 'PATCH') return json(200, await this.patchFolder(folder[1]!, body));
    if (folder && method === 'DELETE') {
      return json(200, await this.write(() => this.notebook.deleteFolder(folder[1]!)));
    }
    const note = /^\/api\/notes\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (note && NOTE_ID.test(decodeURIComponent(note[1]!))) {
      const id = decodeURIComponent(note[1]!);
      const action = note[2];
      if (action === undefined && method === 'DELETE') return this.purge(id);
      if (action === 'move' && method === 'POST') return this.move(id, body);
      if (action === 'trash' && method === 'POST') return json(200, await this.trash(id));
      if (action === 'restore' && method === 'POST') return json(200, await this.restore(id, body));
      if (action === 'backlinks' && method === 'GET') return json(200, this.notebook.backlinks(id));
    }
    const version = /^\/api\/notes\/([^/]+)\/versions\/(\d+)\/(restore|revert)$/.exec(path);
    if (version && method === 'POST') {
      const id = decodeURIComponent(version[1]!);
      const number = Number(version[2]);
      try {
        await this.hooks.confirmRestore(id, number, version[3] === 'revert');
      } catch (error) {
        return ownerRefusal(error);
      }
      // Not inside `write`: a restore saves the note as it is first, which syncs (A831).
      const done =
        version[3] === 'restore'
          ? await this.notebook.restoreVersion(id, number)
          : await this.notebook.revertVersion(id, number);
      await this.engine.exclusive(() => this.hooks.changed());
      return json(200, done);
    }
    const attachment = /^\/api\/attachments\/([0-9a-f]{64})$/.exec(path);
    if (attachment) return this.attachment(method, attachment[1]!, query, request.body);
    if (path === '/api/tags/rename' && method === 'POST') {
      const done = await this.write(() =>
        this.notebook.renameTag({
          from: textOf(body['from']),
          to: textOf(body['to']),
          merge: true,
        }),
      );
      return json(202, done);
    }
    if (path === '/api/settings' && method === 'PUT') {
      // The notebook's own settings only: the CLI's local API refuses the apps' (A827).
      const done = await this.write(() => this.notebook.changeSettings(body));
      return json(200, done);
    }
    // The device's settings in this notebook's device map (A1014), for the app's own Settings
    // when it has no account: never through `LocalNotebook`, whose agents may not change them.
    if (path === DEVICE_SETTINGS_PATH && method === 'GET') {
      return json(200, { device: this.deviceSettings() });
    }
    if (path === DEVICE_SETTINGS_PATH && method === 'PUT') return this.changeDeviceSettings(body);
    if (path === AGENT_SESSIONS_PATH && method === 'GET') return json(200, this.agentSessions());
    // Everything else as the CLI's local notes API answers it (the same shapes as the server).
    const run = () =>
      this.rest(`${path}${url.search}`, {
        method,
        headers: { ...request.headers },
        ...(request.body && request.body.byteLength > 0
          ? { body: decoder.decode(request.body) }
          : {}),
      });
    const reply =
      method === 'GET' || path.includes('/versions')
        ? await run()
        : await this.engine.exclusive(async () => {
            const done = await run();
            await this.hooks.changed();
            return done;
          });
    return {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
      body: encoder.encode(await reply.text()),
    };
  }

  /** The device map (A1014): every `device/<key>`, the notebook's own keys left out as the Mac does. */
  deviceSettings(): Record<string, unknown> {
    const device = readSettings(this.workspace, DEVICE_SETTINGS);
    for (const key of Object.keys(device)) if (isNotebookSetting(key)) delete device[key];
    return device;
  }

  /**
   * `PUT /android/device-settings` `{ set: { key: value | null } }` (A1014): each written as the
   * Mac writes it (`setSetting(doc, 'device', key, value)`, the JSON value as it is), a null
   * removing it so its default shows. Answers the device map after the change.
   */
  private async changeDeviceSettings(body: Body): Promise<LocalReply> {
    const set = body['set'];
    if (typeof set !== 'object' || set === null || Array.isArray(set)) {
      return refusal(400, 'invalid_request', 'Expected { set }');
    }
    const entries = Object.entries(set as Record<string, unknown>);
    if (entries.length === 0) return refusal(400, 'invalid_request', 'set names no setting');
    if (entries.length > DEVICE_SETTINGS_PER_CHANGE) {
      return refusal(
        400,
        'invalid_request',
        `At most ${DEVICE_SETTINGS_PER_CHANGE} settings at once`,
      );
    }
    for (const [key] of entries) {
      if (!SETTING_KEY.test(key)) return refusal(400, 'invalid_request', `Not a setting: ${key}`);
      if (isNotebookSetting(key)) {
        return refusal(403, 'setting_not_allowed', `${key} is the notebook's own setting`);
      }
    }
    const live = readSettings(this.workspace, DEVICE_SETTINGS);
    const writes = entries.filter(
      ([key, value]) => JSON.stringify(live[key] ?? null) !== JSON.stringify(value ?? null),
    );
    if (writes.length > 0) {
      await this.write(() => {
        this.workspace.transact(() => {
          for (const [key, value] of writes) {
            setSetting(this.workspace, DEVICE_SETTINGS, key, value === null ? undefined : value);
          }
        });
      });
    }
    return json(200, { device: this.deviceSettings(), changed: writes.length > 0 });
  }

  // --- /sync ---

  /** `GET /sync/tree` (A281), as the server's `syncTreeOf`, with the notebook's settings (A827). */
  tree(since: string | null) {
    const workspace = readWorkspace(this.workspace);
    const parents = effectiveParents(workspace.folders);
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const settings = this.ops.settings();
    const timeZone = this.ops.timeZone();
    const shown: Record<string, unknown> = { timeZone };
    for (const key of ['template.daily', 'template.weekly']) {
      if (typeof settings[key] === 'string') shown[key] = settings[key];
    }
    const kinds = new Map<string, { kind: string; period: string }>();
    for (const note of workspace.notes) {
      const info = this.notebook.describe(note.id, note.folderId);
      if (info && (info.kind === 'daily' || info.kind === 'weekly') && info.period) {
        kinds.set(note.id, { kind: info.kind, period: info.period });
      }
    }
    const tree = {
      rootSortMode: workspace.rootSortMode,
      // Captures go to the Journal's Inbox or today's note, as on the server (T34), in the
      // notebook's own time zone (A827).
      capture: { destination: 'daily', timeZone },
      settings: shown,
      // The device's settings kept in this notebook (A1014): what the app shows with no account
      // when this is the Journal notebook, and a Mac's change reaches it with the next pass.
      device: this.deviceSettings(),
      folders: workspace.folders
        .map((folder) => ({
          id: folder.id,
          name: folder.name,
          parentId: parents.get(folder.id) ?? null,
          position: folder.position,
          sortMode: folder.sortMode,
        }))
        .sort(byId),
      notes: workspace.notes
        .filter((note) => !isPurged(this.workspace, note.id))
        .map((note) => ({
          id: note.id,
          folderId: note.folderId !== null && parents.has(note.folderId) ? note.folderId : null,
          position: note.position,
          ...kinds.get(note.id),
        }))
        .sort(byId),
    };
    const hash = textHash(JSON.stringify(tree));
    return hash === since ? { hash, unchanged: true } : { hash, ...tree };
  }

  /**
   * Gives every note whose replica `rev` moved since it was last listed a new clock, and every
   * note deleted for good a tombstone; saves that before anything is answered from it.
   */
  private async scan(): Promise<void> {
    let clock = this.state.clock;
    const notes: Record<string, { rev: number; clock: number }> = { ...this.state.notes };
    const gone: Record<string, number> = { ...this.state.gone };
    let moved = false;
    const purged = purgedIds(this.workspace);
    const held = new Set(this.engine.replica.noteIds());
    for (const id of held) {
      if (purged.has(id)) continue;
      const rev = this.engine.replica.rev(id);
      if (notes[id]?.rev === rev && gone[id] === undefined) continue;
      notes[id] = { rev, clock: ++clock };
      delete gone[id];
      moved = true;
    }
    for (const id of new Set([...purged, ...Object.keys(notes)])) {
      if (held.has(id) && !purged.has(id)) continue;
      if (gone[id] !== undefined) continue;
      gone[id] = ++clock;
      delete notes[id];
      moved = true;
    }
    if (!moved) return;
    this.state = { ...this.state, clock, notes, gone };
    await this.saveState(this.state);
  }

  /** `GET /sync/changes`: notes changed after `since`, oldest change first. */
  async changes(since: number) {
    await this.scan();
    const rows: Array<{ id: string; clock: number }> = [];
    for (const [id, entry] of Object.entries(this.state.notes)) {
      if (entry.clock > since) rows.push({ id, clock: entry.clock });
    }
    for (const [id, clock] of Object.entries(this.state.gone)) {
      if (clock > since) rows.push({ id, clock });
    }
    rows.sort((a, b) => a.clock - b.clock);
    const page = rows.slice(0, CHANGES_PAGE);
    const filed = new Map(
      readWorkspace(this.workspace).notes.map((note) => [note.id, note.folderId]),
    );
    const notes = page.map(({ id, clock }) => {
      if (this.state.gone[id] !== undefined) {
        return {
          id,
          clock,
          seq: clock,
          title: '',
          excerpt: '',
          updatedAt: 0,
          deleted: true,
          purged: true,
          links: [],
          tags: [],
        };
      }
      const info = this.notebook.describe(id, filed.get(id) ?? null);
      if (!info) {
        return {
          id,
          clock,
          seq: clock,
          title: '',
          excerpt: '',
          updatedAt: 0,
          deleted: true,
          purged: true,
          links: [],
          tags: [],
        };
      }
      const links = [
        ...new Set(
          info.links
            .map((link) => link.noteId)
            .filter((target): target is string => !!target && target !== id),
        ),
      ].sort();
      return {
        id,
        clock,
        seq: clock,
        title: info.title,
        excerpt: excerptOf(info.text),
        updatedAt: info.updatedAt,
        deleted: info.deleted,
        ...(info.kind === 'daily' || info.kind === 'weekly'
          ? { kind: info.kind, period: info.period }
          : {}),
        links,
        // A note in Trash keeps no tags (T18), as the server's index.
        tags: info.deleted ? [] : [...info.tags].sort(),
      };
    });
    const hasMore = rows.length > CHANGES_PAGE;
    return { clock: hasMore ? (page.at(-1)?.clock ?? since) : this.state.clock, hasMore, notes };
  }

  /** `POST /sync/batch`: each note's uploads taken in, then what the phone lacks of it. */
  private async batch(body: Body): Promise<LocalReply> {
    const entries = body['notes'];
    if (!Array.isArray(entries) || entries.length > BATCH_MAX_NOTES) {
      return refusal(
        400,
        'invalid_request',
        `notes must be an array of at most ${BATCH_MAX_NOTES}`,
      );
    }
    for (const entry of entries as unknown[]) {
      const id = (entry as Body | null)?.['id'];
      if (typeof id !== 'string' || !NOTE_ID.test(id)) {
        return refusal(400, 'invalid_request', 'Each note needs an id');
      }
      const update = (entry as Body)['update'];
      if (
        update !== undefined &&
        update !== null &&
        !(
          Array.isArray(update) &&
          update.length <= BATCH_MAX_UPDATES &&
          update.every((u) => typeof u === 'string')
        )
      ) {
        return refusal(
          400,
          'invalid_request',
          `update must be a list of at most ${BATCH_MAX_UPDATES}`,
        );
      }
    }
    const uploads = (entries as Body[]).some(
      (entry) => Array.isArray(entry['update']) && (entry['update'] as unknown[]).length > 0,
    );
    const run = async () => {
      const out: unknown[] = [];
      for (const entry of entries as Body[]) out.push(await this.exchange(entry));
      return out;
    };
    // Uploads are saved before the answer confirms them (the phone then forgets its copies).
    const notes = uploads ? await this.write(run) : await run();
    return json(200, { notes });
  }

  private async exchange(entry: Body) {
    const id = entry['id'] as string;
    const epoch = typeof entry['epoch'] === 'string' ? entry['epoch'] : null;
    const list = Array.isArray(entry['update']) ? (entry['update'] as string[]) : [];
    const replica = this.engine.replica;
    if (isPurged(this.workspace, id) || this.engine.withheld()[id] !== undefined) {
      // Deleted for good (A828): never taken back in; a copy that synced before is told so. A
      // copy withheld from the push (A886) neither: Room keeps it, and an edit typed on it since
      // stays with it there, never in the notebook until the person keeps and syncs it.
      return {
        id,
        epoch: null,
        update: '',
        error: epoch !== null || list.length > 0 ? GONE : null,
      };
    }
    if (this.holding && epoch !== null && epoch !== this.state.epoch && !this.released.has(id)) {
      // Room's copy from before Android cleared this store (A886): kept as it is, for the app to
      // bring back what git lacks of it first. Room asks again at its next pass.
      return { id, epoch: null, update: '', error: null, deferred: true };
    }
    const existing = replica.note(id);
    if (epoch !== null && epoch !== this.state.epoch) {
      // The engine's store was made afresh (A5): the phone's copy is replaced by git's, and its
      // unsent edits are kept apart, never merged into a note they were not made on.
      if (!existing) return { id, epoch: null, update: '', error: GONE };
      return {
        id,
        epoch: this.state.epoch,
        update: toBase64(Y.encodeStateAsUpdate(existing)),
        stateVector: toBase64(Y.encodeStateVector(existing)),
        error: EPOCH_MISMATCH,
        ...(await this.textPart(entry, id)),
      };
    }
    let applied: number | undefined;
    let error: string | null = null;
    if (list.length > 0) {
      applied = 0;
      for (const encoded of list) {
        let bytes: Uint8Array;
        try {
          bytes = fromBase64(encoded);
        } catch {
          error = 'Malformed update';
          break;
        }
        if (!isUpdate(bytes)) {
          error = 'Malformed update';
          break;
        }
        try {
          replica.adopt(id, bytes);
        } catch {
          error = 'Malformed update';
          break;
        }
        applied++;
      }
    }
    const doc = replica.note(id);
    if (!doc) return { id, epoch: null, update: '', error };
    let filed: { folderId: string | null } | null = null;
    if (entry['folderId'] !== undefined && (applied ?? 0) > 0)
      filed = this.fileFirstUpload(id, entry['folderId']);
    let update: Uint8Array;
    const vector = typeof entry['stateVector'] === 'string' ? entry['stateVector'] : null;
    try {
      update =
        vector === null
          ? Y.encodeStateAsUpdate(doc)
          : Y.encodeStateAsUpdate(doc, fromBase64(vector));
    } catch {
      update = Y.encodeStateAsUpdate(doc);
      error ??= 'Malformed state vector';
    }
    return {
      id,
      epoch: this.state.epoch,
      update: toBase64(update),
      stateVector: toBase64(Y.encodeStateVector(doc)),
      error,
      ...(applied === undefined ? {} : { applied }),
      ...(await this.textPart(entry, id)),
      ...(filed ? { filed } : {}),
    };
  }

  /** The text part of a batch reply (T40 P6, FD4): the text only when it differs from the phone's. */
  private async textPart(entry: Body, id: string) {
    if (entry['text'] !== true) return {};
    const info = this.notebook.describe(id);
    if (!info) return {};
    const text = capBytes(info.text, MAX_TEXT_BYTES);
    const headings = capBytes(info.headings, MAX_TEXT_BYTES);
    const hash = await sha256Hex(`${text}\u0000${headings}`);
    return entry['textHash'] === hash ? { textHash: hash } : { text, headings, textHash: hash };
  }

  /** Files a note's first upload in the folder it was made in (T43 fix c), only while unfiled. */
  private fileFirstUpload(id: string, folder: unknown): { folderId: string | null } | null {
    if (readWorkspace(this.workspace).notes.some((note) => note.id === id)) return null;
    let folderId = typeof folder === 'string' && FOLDER_ID.test(folder) ? folder : null;
    if (
      folderId !== null &&
      !readWorkspace(this.workspace).folders.some((each) => each.id === folderId)
    ) {
      const place = fallbackFolder(this.workspace, folderId);
      folderId = 'folderId' in place ? place.folderId : null;
    }
    registerNote(this.workspace, { id, folderId });
    return { folderId };
  }

  // --- notes and folders, in the shapes the phone reads ---

  private registry(id: string) {
    return readWorkspace(this.workspace).notes.find((note) => note.id === id) ?? null;
  }

  private requireNote(id: string): Y.Doc {
    const doc = this.ops.note(id);
    if (!doc || !this.registry(id) || isPurged(this.workspace, id)) {
      throw new LocalError(404, 'note_not_found', 'No such note');
    }
    return doc;
  }

  /** `POST /api/notes/:id/move`, with the phone's precondition and place (A359, NT7). */
  private async move(id: string, body: Body): Promise<LocalReply> {
    const target = body['folderId'] ?? null;
    if (target !== null && (typeof target !== 'string' || !FOLDER_ID.test(target))) {
      return refusal(400, 'invalid_request', 'folderId must be a folder id or null');
    }
    return this.write(() => {
      const doc = this.ops.note(id);
      if (!doc || isPurged(this.workspace, id)) return refusal(404, 'not_found', 'No such note');
      if (isDeleted(doc)) return refusal(409, 'in_trash', 'The note is in Trash');
      const snapshot = readWorkspace(this.workspace);
      let folderId = target;
      if (folderId !== null && !snapshot.folders.some((each) => each.id === folderId)) {
        const place = fallbackFolder(this.workspace, folderId);
        if (!('folderId' in place)) return refusal(422, 'folder_not_found', 'No such folder');
        if (this.registry(id)) return refusal(422, 'folder_not_found', 'No such folder');
        folderId = place.folderId;
      }
      const entry = snapshot.notes.find((note) => note.id === id) ?? null;
      if ('fromFolderId' in body && entry) {
        const from = body['fromFolderId'] ?? null;
        if (entry.folderId !== folderId && entry.folderId !== from) {
          return refusal(
            409,
            'note_moved',
            'The note was moved since; read where it is now before moving it',
          );
        }
      }
      const place = (
        typeof body['place'] === 'object' && body['place'] !== null ? body['place'] : undefined
      ) as { before?: string; after?: string } | undefined;
      const siblings = snapshot.notes
        .filter((note) => note.folderId === folderId && note.id !== id)
        .sort(compareOrder);
      const position = orderKey(siblings, place);
      if (!entry) registerNote(this.workspace, { id, folderId, position });
      else if (entry.folderId !== folderId || place !== undefined)
        moveNote(this.workspace, id, folderId, position);
      return json(200, { id, folderId });
    });
  }

  /** `POST /api/notes/:id/trash` (T21): `{ folderId, deletedAt, seq }` as the phone reads it. */
  private async trash(id: string) {
    return this.write(() => {
      this.requireNote(id);
      const done = this.ops.trash(id);
      return { folderId: done.folderId, deletedAt: done.deletedAt, seq: this.state.clock + 1 };
    });
  }

  /** `POST /api/notes/:id/restore`, back where it was or into `folderId` (T40 P3a). */
  private async restore(id: string, body: Body) {
    return this.write(() => {
      this.requireNote(id);
      const done = this.ops.restore(id);
      let folderId = done.folderId;
      if ('folderId' in body) {
        const into = body['folderId'] ?? null;
        const known =
          into === null ||
          (typeof into === 'string' &&
            readWorkspace(this.workspace).folders.some((each) => each.id === into));
        if (known) {
          this.ops.move(id, into);
          folderId = into;
        }
      }
      return { folderId, restored: done.restored, seq: this.state.clock + 1 };
    });
  }

  /** `GET /api/trash`: the notes in Trash, newest first. */
  private trashList() {
    const out: Array<Record<string, unknown>> = [];
    for (const entry of readWorkspace(this.workspace).notes) {
      const doc = this.ops.note(entry.id);
      if (!doc || !isDeleted(doc) || isPurged(this.workspace, entry.id)) continue;
      const info = this.notebook.describe(entry.id, entry.folderId);
      const trash = readTrashInfo(doc);
      out.push({
        id: entry.id,
        title: info?.title ?? '',
        deletedAt: trash.at ?? 0,
        updatedAt: info?.updatedAt ?? 0,
      });
    }
    return out.sort((a, b) => Number(b['deletedAt']) - Number(a['deletedAt']));
  }

  /** `GET /api/folders/trash`: the folders in Trash. */
  private folderTrash() {
    return readFolderTrash(this.workspace, this.hooks.now()).map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      deletedAt: folder.deletedAt,
      ...(folder.deletedBy ? { deletedBy: folder.deletedBy } : {}),
      folders: folder.folders,
      notes: folder.notes,
    }));
  }

  private async restoreFolder(id: string) {
    return this.write(() => {
      const done = this.ops.restoreFolder(id);
      return {
        id,
        restored: done.restored,
        parentGone: done.parentGone,
        notes: done.notes,
        skipped: done.skipped,
        parentId: done.parentId ?? null,
      };
    });
  }

  private async createFolder(body: Body): Promise<LocalReply> {
    if (body['notebook'] === true) {
      return refusal(422, 'not_available', 'A git notebook has no notebooks inside it');
    }
    const parentId = body['parentId'] ?? null;
    if (parentId !== null && typeof parentId !== 'string') {
      return refusal(400, 'invalid_request', 'parentId must be a folder id or null');
    }
    const made = await this.write(() =>
      this.notebook.createFolder({ id: textOf(body['id']), name: textOf(body['name']), parentId }),
    );
    return json(made.status, made.folder);
  }

  private async patchFolder(id: string, body: Body) {
    if (body['notebook'] !== undefined) {
      throw new LocalError(422, 'not_available', 'A git notebook has no notebooks inside it');
    }
    const from = (
      typeof body['from'] === 'object' && body['from'] !== null ? body['from'] : {}
    ) as Body;
    const place = (
      typeof body['place'] === 'object' && body['place'] !== null ? body['place'] : undefined
    ) as { before?: string; after?: string } | undefined;
    return this.write(() =>
      this.notebook.patchFolder(id, {
        ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
        ...(typeof from['name'] === 'string' ? { expectedName: from['name'] } : {}),
        ...('parentId' in body
          ? { changeParent: true, parentId: (body['parentId'] as string | null) ?? null }
          : {}),
        ...('parentId' in from
          ? { expectParent: true, expectedParentId: (from['parentId'] as string | null) ?? null }
          : {}),
        ...(body['sortMode'] !== undefined ? { sortMode: sortModeOf(body['sortMode']) } : {}),
        ...(place ? { place } : {}),
      }),
    );
  }

  /** `GET /api/search`: keyword only (A101), in the phone's shape. */
  private async search(query: URLSearchParams) {
    const number = (name: string) => (query.has(name) ? Number(query.get(name)) : null);
    const mode = query.get('mode') === 'semantic' ? 'full-text' : (query.get('mode') ?? 'hybrid');
    const found = (await this.notebook.search({
      q: query.get('q') ?? '',
      mode,
      limit: number('limit') ?? 10,
      tag: query.get('tag'),
      folderId: query.get('folder'),
      after: number('after'),
      before: number('before'),
    })) as { results?: unknown[]; notice?: string };
    return {
      results: found.results ?? [],
      notice: 'A git notebook searches words only (A101).',
    };
  }

  /**
   * Delete for good (A828, A855): the owner check first, named from the branch by the app; then
   * the mark, which the app's commit check lets through only for this confirmed note.
   */
  private async purge(id: string): Promise<LocalReply> {
    if (isPurged(this.workspace, id)) return empty(204);
    if (!this.ops.note(id)) return refusal(404, 'note_not_found', 'No such note');
    try {
      await this.hooks.confirmPurge(id);
    } catch (error) {
      return ownerRefusal(error);
    }
    await this.write(() => this.ops.purge(id));
    return empty(204);
  }

  /**
   * Keep note (A855): takes back a Delete for good that has not landed, the note filed where it
   * was; the app checked the branch first (a landed purge is never taken back). Nothing is
   * deleted, so no owner check. `unkeep` (Undo) marks it again.
   */
  async keep(id: string, keep: boolean): Promise<void> {
    if (!NOTE_ID.test(id)) throw new LocalError(400, 'invalid_request', 'Not a note id');
    await this.write(() => {
      if (keep) unmarkPurged(this.workspace, id);
      else if (!isPurged(this.workspace, id)) markPurged(this.workspace, id, this.hooks.now());
    });
  }

  /**
   * A note as this phone's Room held it before the engine's store was cleared (A886: Android
   * evicts a WebView's IndexedDB when storage runs low). Its updates are Room's whole copy, the
   * edits the old store took in and never pushed among them. Asked only once a sync has fetched
   * the head (the host answers `later` before), so git's notes and its Delete for good marks are
   * known:
   *
   * - deleted for good (at head, or marked here): `done`, and nothing of it comes back: never
   *   under a new id, which neither the guard nor `reversed` would know (the PR #167 probe);
   * - git has every edit it holds, and its place in or out of Trash: `done`;
   * - else it comes back as a new note, "<title> (recovered)", filed where the note was, and in
   *   Trash when it was in Trash (here or in git): fresh content of this writer's, so no client
   *   id of the old store is ever written again (A850).
   *
   * Throws on a copy it cannot read; the app keeps that copy and says so.
   */
  async recover(input: {
    readonly noteId: string;
    readonly updates: readonly Uint8Array[];
    readonly folderId: string | null;
  }): Promise<RecoverAnswer> {
    if (!NOTE_ID.test(input.noteId)) throw new LocalError(400, 'invalid_request', 'Not a note id');
    const old = new Y.Doc();
    const copy = new Y.Doc();
    try {
      for (const bytes of input.updates) {
        if (!isUpdate(bytes)) throw new LocalError(400, 'invalid_request', 'Malformed update');
        Y.applyUpdate(old, bytes);
      }
      // Decided and written in one turn of the engine's lock, against the notebook as it is
      // then: a sync waiting ahead of it may fetch another device's Delete for good, and a
      // check made before the wait would bring the note back (the PR #167 delta check).
      const answer = await this.engine.exclusive(async (): Promise<RecoverAnswer> => {
        if (isPurged(this.workspace, input.noteId)) return { status: 'done' };
        const current = this.engine.replica.note(input.noteId);
        const inTrash = isDeleted(old) || (current !== undefined && isDeleted(current));
        if (current) {
          // What the old copy adds to git's: nothing, once git has every edit it holds and has it
          // in Trash too when it was there.
          const merged = new Y.Doc();
          try {
            Y.applyUpdate(merged, Y.encodeStateAsUpdate(current));
            const before = noteContent(merged);
            Y.applyUpdate(merged, Y.encodeStateAsUpdate(old));
            const trashLost = isDeleted(old) && !isDeleted(current);
            if (noteContent(merged) === before && !trashLost) return { status: 'done' };
          } finally {
            merged.destroy();
          }
        } else if (readTitle(old).trim() === '' && bodyOf(old) === bodyOf(null)) {
          return { status: 'done' };
        }
        const now = new Date(this.hooks.now());
        const id = ulid(now.getTime());
        const title = `${readTitle(old).trim() || 'Untitled'} (recovered)`;
        const notebook = readNoteNotebook(old);
        const trashedAt = readTrashInfo(old).at ?? now.getTime();
        let folderId =
          input.folderId !== null && FOLDER_ID.test(input.folderId) ? input.folderId : null;
        if (
          folderId !== null &&
          !readWorkspace(this.workspace).folders.some((each) => each.id === folderId)
        ) {
          const place = fallbackFolder(this.workspace, folderId);
          folderId = 'folderId' in place ? place.folderId : null;
        }
        copy.transact(() => {
          initNote(
            copy,
            { id, created: isoWithOffset(now), kind: 'note', ...(notebook ? { notebook } : {}) },
            title,
          );
          copy.get(NOTE_ROOT).applyDelta(old.get(NOTE_ROOT).toDeltaDeep());
        });
        // In Trash it stays in Trash, never in a live folder.
        if (inTrash) setDeleted(copy, true, null, { at: trashedAt, folderId });
        this.engine.replica.adopt(id, Y.encodeStateAsUpdate(copy));
        registerNote(this.workspace, { id, folderId });
        // Where it came from, so a Delete for good of the original that races its first push
        // drops it at the commit, and main refuses it (A886).
        markRecoveredFrom(this.workspace, id, input.noteId);
        await this.hooks.changed();
        return { status: 'recovered', id, title };
      });
      this.releaseOldCopy(input.noteId);
      return answer;
    } finally {
      old.destroy();
      copy.destroy();
    }
  }

  /**
   * Keep and sync (A886): a copy withheld from the push, its original deleted for good on another
   * device, back in the notebook as the person confirmed (the app's owner check, naming it):
   * Room's rows of it, every edit typed on it since included, and what the engine kept, filed
   * where it was, its link kept. It is pushed at the next sync, and main lets it through only with
   * that confirmation.
   */
  async keepCopy(input: {
    readonly noteId: string;
    readonly origin: string;
    readonly folderId: string | null;
    readonly updates: readonly Uint8Array[];
  }): Promise<{ readonly status: 'kept'; readonly title: string }> {
    if (!NOTE_ID.test(input.noteId) || !NOTE_ID.test(input.origin)) {
      throw new LocalError(400, 'invalid_request', 'Not a note id');
    }
    for (const bytes of input.updates) {
      if (!isUpdate(bytes)) throw new LocalError(400, 'invalid_request', 'Malformed update');
    }
    return this.engine.exclusive(async () => {
      if (isPurged(this.workspace, input.noteId)) {
        throw new LocalError(409, 'purged', 'That copy is deleted for good');
      }
      const held = this.engine.withheld()[input.noteId];
      const replica = this.engine.replica;
      const docs = [...(held?.update ? [fromBase64(held.update)] : []), ...input.updates];
      if (docs.length === 0) throw new LocalError(400, 'invalid_request', 'Nothing to keep');
      for (const bytes of docs) replica.adopt(input.noteId, bytes);
      let folderId = input.folderId ?? held?.folderId ?? null;
      if (folderId !== null && !FOLDER_ID.test(folderId)) folderId = null;
      if (
        folderId !== null &&
        !readWorkspace(this.workspace).folders.some((each) => each.id === folderId)
      ) {
        const place = fallbackFolder(this.workspace, folderId);
        folderId = 'folderId' in place ? place.folderId : null;
      }
      registerNote(this.workspace, { id: input.noteId, folderId });
      markRecoveredFrom(this.workspace, input.noteId, held?.origin ?? input.origin);
      this.engine.keepCopy(input.noteId);
      await this.hooks.changed();
      return { status: 'kept', title: readTitle(replica.note(input.noteId)!) };
    });
  }

  /** A withheld copy the person deleted for good on this phone (A886): forgotten here too. */
  async forgetCopy(noteId: string): Promise<void> {
    if (!NOTE_ID.test(noteId)) throw new LocalError(400, 'invalid_request', 'Not a note id');
    await this.engine.exclusive(async () => {
      this.engine.forgetWithheld(noteId);
      await this.engine.save();
    });
  }

  /**
   * An old copy's text, for the person to save when it could not be brought back (A886): what
   * of it can be read, in the mirror's markdown; null when none of it can.
   */
  oldCopyText(
    noteId: string,
    updates: readonly Uint8Array[],
  ): { title: string; markdown: string } | null {
    const old = new Y.Doc();
    try {
      let read = 0;
      for (const bytes of updates) {
        try {
          if (!isUpdate(bytes)) continue;
          Y.applyUpdate(old, bytes);
          read++;
        } catch {
          // Unreadable: the rest may still be read.
        }
      }
      if (read === 0) return null;
      const markdown = mirrorMarkdown(readNoteState(old), noteId, this.hooks.now(), {
        link: () => null,
        assetPrefix: '',
      }).markdown;
      return { title: readTitle(old).trim() || 'Untitled', markdown };
    } catch {
      return null;
    } finally {
      old.destroy();
    }
  }

  /** Attachments (A828): kept in the engine's store and committed under `attachments/`. */
  private async attachment(
    method: string,
    sha256: string,
    query: URLSearchParams,
    body: Uint8Array | null,
  ): Promise<LocalReply> {
    if (!SHA256.test(sha256)) return refusal(400, 'invalid_request', 'Not an attachment');
    if (method === 'PUT') {
      const bytes = body ?? new Uint8Array();
      const ext = (query.get('ext') ?? 'bin').toLowerCase();
      if (!/^[a-z0-9]{1,10}$/.test(ext))
        return refusal(400, 'invalid_request', 'Not a file extension');
      const kept = await this.write(() => this.ops.keepAttachment(bytes, ext));
      if (kept.sha256 !== sha256)
        return refusal(400, 'hash_mismatch', 'The file does not have that SHA-256');
      return json(201, { sha256, path: kept.path });
    }
    const file = await this.findAttachment(sha256);
    if (method === 'HEAD') {
      return file
        ? {
            status: 200,
            headers: { 'content-length': String(file.byteLength) },
            body: new Uint8Array(),
          }
        : empty(404);
    }
    if (method === 'GET') {
      return file
        ? {
            status: 200,
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(file.byteLength),
            },
            body: file,
          }
        : refusal(404, 'not_found', 'No such attachment');
    }
    return refusal(405, 'method_not_allowed', `${method} attachments`);
  }

  /** An attachment by its hash: in the store, else at the branch's head (another writer's). */
  private async findAttachment(sha256: string): Promise<Uint8Array | null> {
    const storage = this.engine.storage;
    const lastHead = this.engine.replica.state.lastHead;
    const root = this.engine.transport.root;
    if (lastHead) {
      const files = await this.engine.transport.list(lastHead);
      for (const path of files.keys()) {
        const name = path.slice(`${root}attachments/`.length);
        if (!path.startsWith(`${root}attachments/`) || !name.startsWith(`${sha256}.`)) continue;
        const local = await storage.readAttachment(name);
        if (local) return local;
        return (await this.engine.transport.read(lastHead, [path])).get(path) ?? null;
      }
    }
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'bin', 'heic', 'avif']) {
      const local = await storage.readAttachment(`${sha256}.${ext}`);
      if (local) return local;
    }
    return null;
  }

  /**
   * `POST /api/capture` (T34, A335, A827): today's note's Captures, or a new note in the
   * Inbox, made here, offline, and pushed with the next sync. A retry of a capture adds nothing.
   */
  private async capture(body: Body) {
    const id = textOf(body['id']);
    const text = textOf(body['text']);
    // The phone's capture ids are its drafts' (UUIDs), as the server takes them (A335).
    if (!CAPTURE_ID.test(id)) throw new LocalError(400, 'invalid_request', 'A capture needs an id');
    if (!text.trim()) throw new LocalError(400, 'invalid_request', 'Nothing to capture');
    const destination = body['destination'] === 'inbox' ? 'inbox' : 'daily';
    const known = this.state.captures[id];
    if (known) return { id, noteId: known.noteId, destination, changed: false };
    const at = Number.isFinite(Number(body['capturedAt']))
      ? Number(body['capturedAt'])
      : this.hooks.now();
    const zone =
      typeof body['timeZone'] === 'string' && isTimeZone(body['timeZone'])
        ? body['timeZone']
        : this.ops.timeZone();
    // Its Inbox note's id comes from the capture's, so a capture sent again after the store was
    // lost (a new epoch) makes the same note, never a second one.
    const noteIdOf = await captureNoteId(id);
    const noteId = await this.write(() => {
      if (destination === 'daily') {
        const day = this.ops.daily({
          kind: 'daily',
          date: todayIn(zone, new Date(at)).toString(),
          create: true,
        });
        appendCapture(this.ops.note(day.id)!, text, captureTime(new Date(at), zone));
        return day.id;
      }
      const { title, body: markdown } = splitCapture(text);
      const inbox = this.inbox();
      return this.ops.createNote({
        id: noteIdOf,
        title,
        folderId: inbox,
        body: parseMarkdown(markdown).doc,
      });
    });
    const captures = Object.entries({ ...this.state.captures, [id]: { noteId, at } })
      .sort((a, b) => a[1].at - b[1].at)
      .slice(-MAX_CAPTURES);
    this.state = { ...this.state, captures: Object.fromEntries(captures) };
    await this.saveState(this.state);
    return { id, noteId, destination, changed: true };
  }

  /** The Inbox that captures filed as new notes go to: the notebook's own, else a derived one. */
  private inbox(): string {
    const folders = readWorkspace(this.workspace).folders;
    const own = folders.find(
      (folder) => folder.parentId === null && folder.name.trim().toLowerCase() === 'inbox',
    );
    if (own) return own.id;
    const id = journalFolderId(INBOX, this.ops.salt);
    if (!folders.some((folder) => folder.id === id)) {
      createFolder(this.workspace, { id, name: INBOX, parentId: null });
    }
    return id;
  }
}

/** The owner check said no (or could not ask): nothing was changed. */
function ownerRefusal(error: unknown): LocalReply {
  const coded = error as { code?: unknown; message?: unknown } | null;
  return refusal(
    403,
    typeof coded?.code === 'string' ? coded.code : 'not_confirmed',
    typeof coded?.message === 'string' ? coded.message : 'Not confirmed on this phone.',
  );
}

function sortModeOf(value: unknown): 'manual' | 'alpha' | 'modified' {
  if (value === 'manual' || value === 'alpha' || value === 'modified') return value;
  throw new LocalError(400, 'invalid_request', 'sortMode must be manual, alpha or modified');
}

/** An order key immediately before or after an anchor among siblings, else at the end (NT7). */
function orderKey(
  siblings: ReadonlyArray<{ readonly id: string; readonly position: string }>,
  place: { readonly before?: string; readonly after?: string } | undefined,
): string {
  const anchor = place?.before ?? place?.after ?? null;
  const at = anchor === null ? -1 : siblings.findIndex((sibling) => sibling.id === anchor);
  if (at < 0) return keyBetween(siblings.at(-1)?.position ?? null, null);
  if (place?.before !== undefined) {
    return keyBetween(at > 0 ? siblings[at - 1]!.position : null, siblings[at]!.position);
  }
  return keyBetween(siblings[at]!.position, siblings[at + 1]?.position ?? null);
}

/** A note's title and body as structure, to tell whether a merge changed what it shows. */
function noteContent(doc: Y.Doc): string {
  return JSON.stringify({ title: readTitle(doc), body: bodyOf(doc) });
}

/** A note's body as structure; `null`: an empty one's. */
function bodyOf(doc: Y.Doc | null): string {
  const read = doc ?? new Y.Doc();
  try {
    return JSON.stringify(read.get(NOTE_ROOT).toDeltaDeep().toJSON());
  } finally {
    if (!doc) read.destroy();
  }
}
