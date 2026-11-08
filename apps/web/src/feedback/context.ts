/**
 * Send feedback's captured context on the web and in the Mac app (T49, A791): where you are and
 * the metadata of what's on screen, in core's groups (no history group since T59: a note's history
 * is its git notebook's, A889, A1036). Never a note's body text, excerpts,
 * search queries or other notes' text.
 *
 * Two steps, so a test can check each: `gatherContext` reads the live app when the form opens,
 * before the form is drawn (counts are taken from the note's text here; the text itself goes no
 * further), and `buildContext` turns what was gathered into the groups, redacting the recent
 * errors and dropping any that quote the open note.
 */
import {
  clipCell,
  ERROR_COLUMNS,
  fieldGroup,
  FEEDBACK_LIMITS,
  quotesNoteText,
  redactText,
  type FeedbackContext,
  type FeedbackGroup,
} from '@penmoss/core/feedback';
import type { RecentError } from './errors';

export interface AppFacts {
  readonly client: 'web' | 'mac';
  readonly version: string;
  readonly os: string;
  readonly browser: string;
  readonly window: string;
  readonly viewport: string;
  readonly pixelRatio: number;
  readonly theme: string;
  readonly appearance: string;
  readonly locale: string;
  readonly timeZone: string;
  /** The Mac app's title bar (compact or native); absent elsewhere. */
  readonly titleBar?: string;
  /** The Mac window's keep on top; absent elsewhere. */
  readonly keepOnTop?: boolean;
}

export interface WhereFacts {
  /** The path, ids kept, never a query string or fragment. */
  readonly route: string;
  readonly screen: string;
  /** Panels and dialogs open behind the form (Info, Version history, Settings…). */
  readonly panels: readonly string[];
  /** How the form was opened (palette, menu, key, button, Mac menu). */
  readonly openedFrom: string;
  readonly sidebar: string;
  readonly selectedFolder: string | null;
  /** Opened on a git notebook's note (A826, A828, A889): the route is its kind only. */
  readonly git?: boolean;
}

/** What the context says, in the preview and the issue, when it was opened in a git notebook. */
export const GIT_NOTICE =
  'nothing of the notebook is sent: no note id, title, folder, tags, dates, authors or screen capture';

export interface SyncFacts {
  readonly online: boolean;
  readonly state: string;
  readonly lastSynced: number | null;
  readonly unsyncedNotes: number;
  readonly feedbackOutbox: number;
  /** The last sync error the app showed (its words), or null. */
  readonly lastError: string | null;
}

export interface NoteFacts {
  /** A git notebook's note (A889): only its counts and states are sent. */
  readonly source?: 'git';
  readonly id: string;
  readonly title: string;
  readonly folder: string;
  /** Its notebook's name (T43): the default notebook's for a note outside the others. */
  readonly notebook?: string;
  readonly tags: readonly string[];
  readonly created: string | null;
  readonly updated: number | null;
  readonly kind: string | null;
  readonly words: number | null;
  readonly characters: number | null;
  readonly attachments: number | null;
  readonly bytes: number | null;
  readonly engine: string | null;
  readonly epoch: string | null;
  readonly unsynced: boolean;
  readonly inTrash: boolean;
  readonly backlinks: number;
  readonly outgoingLinks: number;
  readonly windows: number;
}

/** What `gatherContext` read when the form opened. */
export interface ContextFacts {
  readonly app: AppFacts;
  readonly where: WhereFacts;
  readonly sync: SyncFacts;
  readonly note: NoteFacts | null;
  readonly errors: readonly RecentError[];
  /**
   * For redaction only, never sent: note titles and folder names (removed from error text), and
   * the text of every note this window holds open, the open one first (an error quoting any of
   * them is dropped).
   */
  readonly private: { readonly names: readonly string[]; readonly noteTexts: readonly string[] };
}

const iso = (ms: number | null | undefined) =>
  ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString();

const cells = (row: readonly string[]) => row.map((value) => clipCell(value));

/** The groups, in core's order (the note's two only when a note is open). */
export function buildContext(facts: ContextFacts): FeedbackContext {
  const { app, where, sync, note } = facts;
  const groups: FeedbackGroup[] = [
    fieldGroup('app', [
      ['Client', app.client === 'mac' ? 'Mac' : 'web'],
      ['Version', app.version],
      ['OS', app.os],
      ['Browser', app.browser],
      ['Window', app.window],
      ['Viewport', app.viewport],
      ['Pixel ratio', app.pixelRatio],
      ['Theme', app.theme],
      ['Appearance', app.appearance],
      ['Locale', app.locale],
      ['Time zone', app.timeZone],
      ['Title bar', app.titleBar],
      ['Keep on top', app.keepOnTop],
    ]),
    fieldGroup(
      'where',
      where.git
        ? [
            // The screen's kind, never its route: a note's id is the notebook's.
            ['Screen', where.screen],
            ['Open panel', where.panels.length > 0 ? where.panels.join(', ') : 'none'],
            ['Opened from', where.openedFrom],
            ['Sidebar', where.sidebar],
            ['Source', 'a git notebook'],
            ['Git notebook', GIT_NOTICE],
          ]
        : [
            ['Route', where.route],
            ['Screen', where.screen],
            ['Open panel', where.panels.length > 0 ? where.panels.join(', ') : 'none'],
            ['Opened from', where.openedFrom],
            ['Sidebar', where.sidebar],
            ['Selected folder', where.selectedFolder ?? 'top level'],
          ],
    ),
    fieldGroup('sync', [
      ['Online', sync.online],
      ['Sync', sync.state],
      ['Last synced', iso(sync.lastSynced) ?? 'not since the app opened'],
      ['Unsynced notes', sync.unsyncedNotes],
      ['Feedback outbox', sync.feedbackOutbox],
      [
        'Last sync error',
        sync.lastError ? redactText(sync.lastError, facts.private.names) : 'none',
      ],
    ]),
  ];
  if (note?.source === 'git') {
    // Counts and states only (A889); no history either: its authors and dates are the notebook's.
    groups.push(
      fieldGroup('note', [
        ['Source', 'a git notebook'],
        ['Words', note.words],
        ['Characters', note.characters],
        ['Attachments', note.attachments],
        ['Size in bytes', note.bytes],
        ['Unsynced', note.unsynced],
        ['In Trash', note.inTrash],
        ['Backlinks', note.backlinks],
        ['Outgoing links', note.outgoingLinks],
        ['Open in windows', note.windows],
      ]),
    );
  } else if (note) {
    groups.push(
      fieldGroup('note', [
        ['Id', note.id],
        ['Title', note.title || 'Untitled'],
        ['Kind', note.kind],
        ['Folder', note.folder || 'top level'],
        ['Notebook', note.notebook ?? null],
        ['Tags', note.tags.length > 0 ? note.tags.map((tag) => `#${tag}`).join(', ') : 'none'],
        ['Created', note.created],
        ['Updated', iso(note.updated)],
        ['Words', note.words],
        ['Characters', note.characters],
        ['Attachments', note.attachments],
        ['Size in bytes', note.bytes],
        ['Engine', note.engine],
        ['Epoch', note.epoch],
        ['Unsynced', note.unsynced],
        ['In Trash', note.inTrash],
        ['Backlinks', note.backlinks],
        ['Outgoing links', note.outgoingLinks],
        ['Open in windows', note.windows],
      ]),
    );
  }
  groups.push({
    id: 'errors',
    columns: ERROR_COLUMNS,
    rows: safeErrors(facts.errors, facts.private).map((error) =>
      cells([iso(error.at) ?? '—', error.message, error.stack]),
    ),
  });
  return { groups };
}

/** The recent errors redacted, without any that quotes a note this window holds (A791). */
export function safeErrors(
  errors: readonly RecentError[],
  secret: ContextFacts['private'],
): RecentError[] {
  return errors
    .filter(
      (error) =>
        !secret.noteTexts.some(
          (text) => quotesNoteText(error.message, text) || quotesNoteText(error.stack, text),
        ),
    )
    .slice(0, FEEDBACK_LIMITS.recent)
    .map((error) => ({
      at: error.at,
      message: redactText(error.message, secret.names),
      stack: error.stack
        .split('\n')
        .map((line) => redactText(line, secret.names))
        .join('\n'),
    }));
}
