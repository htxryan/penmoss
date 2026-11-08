// @vitest-environment happy-dom
/**
 * Send feedback's captured context on the web and in the Mac app (T49, A791): metadata only,
 * in core's groups (no history group since T59: a note's history is its git notebook's). A note
 * whose body holds a unique marker string is open, its text appears in an excerpt, a link's
 * context, an error and the address's query, and the marker reaches no group, no preview and no
 * payload.
 */
import { contextMarkdown, withoutGroups, type FeedbackContext } from '@penmoss/core/feedback';
import { parseMarkdown } from '@penmoss/core';
import { initNote } from '@penmoss/sync-client/note';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { describe, expect, it } from 'vitest';
import { buildContext, GIT_NOTICE } from '../../src/feedback/context';
import { appFrames, ErrorRing, loggedError } from '../../src/feedback/errors';
import {
  browserOf,
  gatherContext,
  osOf,
  panelsOn,
  selectedFolderOn,
  sidebarOn,
  type GatherDeps,
} from '../../src/feedback/gather';
import type { OpenNote } from '../../src/notes/service';

const MARKER = 'MARKER-7f3a9c-quietly-unique';
const NOTE = '01JBX0000000000000000000AA';
const OTHER = '01JBX0000000000000000000AB';
const BODY = `Shopping for the week\n\nThe secret is ${MARKER} and more words after it.\n\n![x](attachments/${'a'.repeat(64)}.png)\n`;

function openNoteWith(body: string): OpenNote {
  const replica = createYjs14Replica();
  initNote(
    replica.doc,
    { id: NOTE, created: '2026-10-20T09:00:00-05:00', kind: 'note' },
    'Groceries',
  );
  return {
    id: NOTE,
    isLoaded: true,
    isClosed: false,
    replica,
    keeper: { unsynced: true, currentEpoch: 'epoch-1', body },
  } as unknown as OpenNote;
}

function deps(overrides: Partial<GatherDeps> = {}): GatherDeps {
  const editorDoc = parseMarkdown(BODY).doc;
  return {
    client: 'mac',
    version: '0.9 (web abc123)',
    window: 'note window',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Penmoss/0.9 Chrome/142.0.7444.0 Electron/39.1.0 Safari/537.36',
    viewport: { width: 1280, height: 800, ratio: 2 },
    locale: 'en-US',
    timeZone: 'America/Chicago',
    theme: { name: 'Moss', variant: 'dark', mode: 'system' },
    mac: { titleBar: 'compact', keepOnTop: true },
    pathname: `/window/notes/${NOTE}?heading=${MARKER}`,
    openedFrom: 'menu',
    panels: ['Info', 'Version history'],
    sidebar: 'none on this screen',
    selectedFolderId: 'f2',
    online: true,
    sync: { phase: 'syncing', pending: 2, detail: null },
    lastSynced: Date.parse('2026-10-27T15:04:05.000Z'),
    lastSyncError: 'stopped (notes): 1 note could not sync: Groceries is too large',
    feedbackOutbox: 1,
    snapshot: {
      folders: [
        { id: 'f1', name: 'Projects', parentId: null, position: 'a', sortMode: 'manual' },
        { id: 'f2', name: 'Penmoss', parentId: 'f1', position: 'a', sortMode: 'manual' },
      ],
      notes: [
        { id: NOTE, folderId: 'f2', position: 'a' },
        { id: OTHER, folderId: null, position: 'b' },
      ],
      rootSortMode: 'manual',
    } as unknown as GatherDeps['snapshot'],
    list: [
      {
        id: NOTE,
        title: 'Groceries',
        excerpt: `The secret is ${MARKER}`,
        updatedAt: Date.parse('2026-10-27T15:00:00.000Z'),
        unsynced: true,
        tags: ['home', 'todo'],
      },
      {
        id: OTHER,
        title: 'Garden plan',
        excerpt: 'Tomatoes',
        updatedAt: 1,
        unsynced: false,
        tags: [],
      },
    ],
    links: [
      {
        id: OTHER,
        title: 'Garden plan',
        updatedAt: 1,
        unsynced: false,
        links: [
          {
            target: 'Groceries',
            noteId: NOTE,
            heading: null,
            alias: null,
            embed: false,
            context: [{ text: `see ${MARKER}` }],
          },
        ],
      },
      { id: NOTE, title: 'Groceries', updatedAt: 1, unsynced: true, links: [] },
    ] as unknown as GatherDeps['links'],
    opened: (id) => (id === NOTE ? [openNoteWith(BODY)] : []),
    openTexts: () => [],
    editorDoc,
    windowsShowing: () => 2,
    errors: [
      {
        at: Date.parse('2026-10-27T15:01:00.000Z'),
        message: 'TypeError: Cannot read properties of undefined',
        stack: 'at render (/src/notes/NoteView.tsx:10:2)',
      },
      {
        at: Date.parse('2026-10-27T15:02:00.000Z'),
        message: `Error: could not parse "The secret is ${MARKER} and more"`,
        stack: '',
      },
      {
        at: Date.parse('2026-10-27T15:03:00.000Z'),
        message: 'Error: Garden plan failed to save',
        stack: '',
      },
    ],
    ...overrides,
  };
}

describe('the captured context (A791)', () => {
  const facts = gatherContext(deps());
  const context = buildContext(facts);
  const json = JSON.stringify(context);
  const markdown = contextMarkdown(context);

  it('has its groups, in order, and no history', () => {
    expect(context.groups.map((group) => group.id)).toEqual([
      'app',
      'where',
      'sync',
      'note',
      'errors',
    ]);
  });

  it('never holds the note’s body text, an excerpt, a link’s context or a query (the marker)', () => {
    expect(json).not.toContain(MARKER);
    expect(markdown).not.toContain(MARKER);
    expect(JSON.stringify(facts.app) + JSON.stringify(facts.where)).not.toContain(MARKER);
    expect(JSON.stringify(facts.note)).not.toContain(MARKER);
    // Nor what is sent: the payload the Mac's main process files as it is (A1010).
    expect(JSON.stringify({ title: 'x', description: '', context })).not.toContain(MARKER);
  });

  it('names the client, version, route, window, panel, sync and the note’s details', () => {
    const field = (group: string, name: string) =>
      context.groups.find((item) => item.id === group)?.rows.find((row) => row[0] === name)?.[1];
    expect(field('app', 'Client')).toBe('Mac');
    expect(field('app', 'Version')).toBe('0.9 (web abc123)');
    expect(field('app', 'OS')).toBe('macOS 10.15.7');
    expect(field('app', 'Browser')).toBe('Electron 39.1.0, Chrome 142.0.7444.0');
    expect(field('app', 'Window')).toBe('note window');
    expect(field('app', 'Title bar')).toBe('compact');
    expect(field('app', 'Keep on top')).toBe('yes');
    expect(field('where', 'Route')).toBe(`/window/notes/${NOTE}`);
    expect(field('where', 'Screen')).toBe('note (in its own window)');
    expect(field('where', 'Open panel')).toBe('Info, Version history');
    expect(field('where', 'Opened from')).toBe('menu');
    expect(field('where', 'Selected folder')).toBe('Projects / Penmoss');
    expect(field('sync', 'Sync')).toBe('syncing');
    expect(field('sync', 'Folders socket')).toBeUndefined();
    expect(field('sync', 'Image uploads waiting')).toBeUndefined();
    expect(field('sync', 'Last synced')).toBe('2026-10-27T15:04:05.000Z');
    expect(field('sync', 'Unsynced notes')).toBe('2');
    // A note's title in the last sync error is removed (A427's redaction).
    expect(field('sync', 'Last sync error')).toBe(
      'stopped (notes): 1 note could not sync: ‹name› is too large',
    );
    expect(field('note', 'Id')).toBe(NOTE);
    expect(field('note', 'Title')).toBe('Groceries');
    expect(field('note', 'Folder')).toBe('Projects / Penmoss');
    expect(field('note', 'Tags')).toBe('#home, #todo');
    expect(field('note', 'Created')).toBe('2026-10-20T09:00:00-05:00');
    expect(field('note', 'Words')).toBe('13');
    expect(field('note', 'Attachments')).toBe('1');
    expect(Number(field('note', 'Size in bytes'))).toBeGreaterThan(0);
    expect(field('note', 'Engine')).toBe('yjs14');
    expect(field('note', 'Epoch')).toBe('epoch-1');
    expect(field('note', 'Unsynced')).toBe('yes');
    expect(field('note', 'In Trash')).toBe('no');
    expect(field('note', 'Backlinks')).toBe('1');
    expect(field('note', 'Outgoing links')).toBe('0');
    expect(field('note', 'Open in windows')).toBe('2');
  });

  it('drops an error that quotes the note and redacts names in the rest', () => {
    const errors = context.groups.find((group) => group.id === 'errors')!;
    expect(errors.rows.map((row) => row[1])).toEqual([
      'TypeError: Cannot read properties of undefined',
      'Error: ‹name› failed to save',
    ]);
  });

  it('has no note groups without a note', () => {
    const home = buildContext(gatherContext(deps({ pathname: '/', mac: null, client: 'web' })));
    expect(home.groups.map((group) => group.id)).toEqual(['app', 'where', 'sync', 'errors']);
    expect(JSON.stringify(home)).not.toContain('Keep on top');
  });

  it('sends exactly the preview: a group left out is in neither', () => {
    const left = withoutGroups(context, new Set(['note', 'errors']));
    const preview = contextMarkdown(left);
    expect(preview).not.toContain('#### This note');
    expect(preview).not.toContain('#### Recent errors');
    expect(preview).toContain('#### Sync');
    expect(contextMarkdown(JSON.parse(JSON.stringify(left)) as FeedbackContext)).toBe(preview);
  });
});

describe('opened from Home, with another note’s text in the recent errors', () => {
  const OTHER_MARKER = `OTHERMARKER-${'b'.repeat(12)}`;
  const otherText = `Garden plan: the ${OTHER_MARKER} sits between the tomatoes and the beans.`;
  const facts = gatherContext(
    deps({
      pathname: '/',
      editorDoc: null,
      openTexts: () => [otherText],
      errors: [
        {
          at: 1,
          message: `Error: could not render the ${OTHER_MARKER} sits between the tomatoes`,
          stack: '',
        },
        { at: 2, message: `Error: at /notes/${OTHER}?q=${OTHER_MARKER}#${MARKER}`, stack: '' },
        { at: 3, message: 'Error: plain failure', stack: '' },
      ],
    }),
  );
  const context = buildContext(facts);

  it('drops an error quoting a note this window holds, and the query of a path', () => {
    const json = JSON.stringify(context);
    expect(json).not.toContain(OTHER_MARKER);
    expect(json).not.toContain(MARKER);
    expect(contextMarkdown(context)).not.toContain(OTHER_MARKER);
    const errors = context.groups.find((group) => group.id === 'errors')!;
    expect(errors.rows.map((row) => row[1])).toEqual([
      `Error: at /notes/${OTHER}`,
      'Error: plain failure',
    ]);
    expect(JSON.stringify({ context })).not.toContain(OTHER_MARKER);
  });

  it('names an unknown path by what it is, not what was typed', () => {
    const stray = gatherContext(deps({ pathname: `/${MARKER}/x`, editorDoc: null }));
    expect(stray.where.route).toBe('(not a Penmoss page)');
    expect(JSON.stringify(buildContext(stray))).not.toContain(MARKER);
  });
});

describe('reading the page', () => {
  it('names the panels, the sidebar and the selected folder from the markup', () => {
    document.body.innerHTML = `
      <div class="notes-app" data-sidebar="collapsed">
        <div class="folder-row" data-key="folder:f2" aria-selected="true"></div>
        <section data-testid="note-info"></section>
        <div class="note-source"></div>
      </div>`;
    expect(panelsOn(document)).toEqual(['Info', 'Markdown source']);
    expect(sidebarOn(document)).toBe('collapsed (icon rail)');
    expect(selectedFolderOn(document)).toBe('f2');
    document.body.innerHTML = '';
    expect(sidebarOn(document)).toBe('none on this screen');
    expect(selectedFolderOn(document)).toBeNull();
  });

  it('names the OS and browser from a user agent', () => {
    const pixel =
      'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
    expect(osOf(pixel)).toBe('Android 16');
    expect(browserOf(pixel)).toBe('Chrome 142.0.0.0');
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
    expect(osOf(firefox)).toBe('Linux');
    expect(browserOf(firefox)).toBe('Firefox 140.0');
  });
});

describe('the recent-errors ring', () => {
  it('keeps the newest 10, newest first, with the app’s own frames', () => {
    const ring = new ErrorRing('https://app.penmoss.app');
    for (let i = 0; i < 12; i++) ring.push(new Error(`e${i}`), i);
    const recent = ring.recent();
    expect(recent).toHaveLength(10);
    expect(recent[0]!.message).toBe('Error: e11');
    expect(recent.at(-1)!.message).toBe('Error: e2');
  });

  it('trims a stack to app frames', () => {
    const stack = [
      'Error: x',
      '    at a (https://app.penmoss.app/assets/index-abc.js:1:2)',
      '    at b (chrome-extension://abcdef/content.js:3:4)',
      '    at c (https://evil.example/x.js:5:6)',
      '    at d (https://app.penmoss.app/assets/index-abc.js:7:8)',
    ].join('\n');
    expect(appFrames(stack, 'https://app.penmoss.app')).toBe(
      'at a (/assets/index-abc.js:1:2)\nat d (/assets/index-abc.js:7:8)',
    );
  });

  it('records console.error calls with the app’s words, never an object’s contents', () => {
    const ring = new ErrorRing('');
    const calls: unknown[][] = [];
    const log = { error: (...args: unknown[]) => void calls.push(args) };
    const target = new EventTarget() as unknown as Window;
    const stop = ring.install(target, log);
    log.error('[notes] could not save', new TypeError('boom'), { body: MARKER });
    stop();
    expect(calls).toHaveLength(1);
    expect(ring.recent()[0]!.message).toBe(
      'Logged: [notes] could not save TypeError: boom (Object)',
    );
    // A library's or React's words are not the app's: named, never kept.
    expect(loggedError(['x', 3]).message).toBe('(text) 3');
    expect(loggedError([`Warning: ${MARKER}`, new TypeError('t')]).message).toBe(
      '(text) TypeError: t',
    );
    expect(loggedError(['[sync] stopped', 3]).message).toBe('[sync] stopped 3');
  });
});

/** A group's rows as name → value. */
function rowsOf(context: FeedbackContext, id: string): Record<string, string> {
  const rows = context.groups.find((group) => group.id === id)?.rows ?? [];
  return Object.fromEntries<string>(rows.map((row) => [row[0] ?? '', row[1] ?? '']));
}

describe('from a git notebook’s note (A826, A828, A889)', () => {
  // The git note open, its notebook's names known only to scrub errors with.
  const facts = gatherContext(
    deps({
      gitNote: true,
      gitNames: ['Acme Work', 'Groceries', 'Clients Zeta'],
      errors: [
        {
          at: Date.parse('2026-10-27T15:03:00.000Z'),
          message: 'Error: Clients Zeta failed to save',
          stack: '',
        },
      ],
    }),
  );
  const context = buildContext(facts);
  const json = JSON.stringify(context);
  const markdown = contextMarkdown(context);
  // What the Mac's main process files, as it is (A1010).
  const sent = JSON.stringify({ title: 'x', description: '', context });

  it('sends none of the note’s id, title, folder, notebook, tags, dates or epoch', () => {
    for (const text of [json, markdown, sent]) {
      for (const secret of [
        NOTE,
        'Groceries',
        'Projects',
        'Penmoss /',
        'Acme',
        'Clients Zeta',
        '#home',
        'todo',
        'epoch-1',
        '2026-10-20',
        MARKER,
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('keeps kinds, counts and states, and the preview says why', () => {
    expect(context.groups.map((group) => group.id)).toEqual([
      'app',
      'where',
      'sync',
      'note',
      'errors',
    ]);
    const where = rowsOf(context, 'where');
    expect(where['Screen']).toBe('note (in its own window)');
    expect(where['Source']).toBe('a git notebook');
    expect(where['Git notebook']).toBe(GIT_NOTICE);
    expect(markdown).toContain(GIT_NOTICE);
    const note = rowsOf(context, 'note');
    expect(Object.keys(note)).toEqual([
      'Source',
      'Words',
      'Characters',
      'Attachments',
      'Size in bytes',
      'Unsynced',
      'In Trash',
      'Backlinks',
      'Outgoing links',
      'Open in windows',
    ]);
    expect(Number(note['Words'])).toBeGreaterThan(0);
  });
});
