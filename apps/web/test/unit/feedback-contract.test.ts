/**
 * In-app feedback's shared rules (T49, A791, A794): apps/android/contract/feedback-v1.json holds
 * contexts with the markdown the issue holds for each, issue bodies and labels. The Worker builds
 * the issue with core's `feedbackIssueBody`; the web and Mac form preview `contextMarkdown`; the
 * Android app renders the same markdown in Kotlin (`FeedbackMarkdownTest` reads this file), so
 * what each form previews is what the issue holds.
 *
 * After changing the rendering, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/web test feedback-contract`, then
 * `pnpm exec prettier --write apps/android/contract/feedback-v1.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  contextMarkdown,
  EDIT_COLUMNS,
  ERROR_COLUMNS,
  feedbackIssueBody,
  feedbackLabels,
  fieldGroup,
  FEEDBACK_LIMITS,
  FEEDBACK_PRIORITY_LABELS,
  FEEDBACK_TYPE_LABELS,
  type FeedbackContext,
  type FeedbackIssueInput,
} from '@penmoss/core/feedback';
import { describe, expect, it } from 'vitest';

const FILE = fileURLToPath(new URL('../../../android/contract/feedback-v1.json', import.meta.url));

const full: FeedbackContext = {
  groups: [
    fieldGroup('app', [
      ['Client', 'Android'],
      ['Version', '0.31 (build 431425)'],
      ['OS', 'Android 16 (API 36)'],
      ['WebView', '142.0.7444.0'],
      ['Window', 'main'],
      ['Screen', '412×915 dp at 2.625×'],
      ['Theme', 'Moss (dark)'],
      ['Appearance', 'system'],
      ['Locale', 'en-US'],
      ['Time zone', 'America/Chicago'],
    ]),
    fieldGroup('where', [
      ['Route', '/notes/01JBXYZ0000000000000000000'],
      ['Screen', 'note'],
      ['Open panel', 'Info'],
      ['Sidebar', 'drawer closed'],
      ['Selected folder', 'Projects / Penmoss'],
    ]),
    fieldGroup('sync', [
      ['Online', true],
      ['Sync', 'synced'],
      ['Note socket', 'synced'],
      ['Last synced', '2026-10-27T15:04:05.000Z'],
      ['Unsynced notes', 0],
      ['Outbox', 1],
      ['Last sync error', 'none'],
    ]),
    fieldGroup('note', [
      ['Id', '01JBXYZ0000000000000000000'],
      ['Title', 'Shopping | list <b>'],
      ['Folder', 'Projects / Penmoss'],
      ['Tags', '#home, #todo'],
      ['Words', 120],
      ['Unsynced', false],
    ]),
    {
      id: 'edits',
      columns: EDIT_COLUMNS,
      rows: [
        ['2026-10-27T15:00:00.000Z', 'Pixel 9', 'typed', '+3 −1 lines'],
        ['2026-10-27T14:00:00.000Z', 'Claude Code ✦', 'agent edit', 'Tags changed'],
      ],
    },
    {
      id: 'errors',
      columns: ERROR_COLUMNS,
      rows: [['2026-10-27T15:01:00.000Z', 'IOException: timeout', 'at a.b.C.d(C.kt:10)\nat x']],
    },
  ],
};

const contexts: Array<{ name: string; context: FeedbackContext }> = [
  { name: 'every group', context: full },
  { name: 'no groups', context: { groups: [] } },
  {
    name: 'empty tables and awkward cells',
    context: {
      groups: [
        fieldGroup('note', [
          ['Title', '  spaced\tout\n\nlines  '],
          ['Path', 'back\\slash'],
          ['Code', 'a ```` b'],
          ['Empty', ''],
          ['References', '#100, #home, @ryan, GH-7, a@b.c'],
        ]),
        { id: 'edits', columns: EDIT_COLUMNS, rows: [] },
        { id: 'errors', columns: ERROR_COLUMNS, rows: [] },
      ],
    },
  },
];

const bodies: Array<{ name: string; input: FeedbackIssueInput }> = [
  {
    name: 'a bug with screenshots',
    input: {
      description: 'It **broke**:\n\n- one\n- two\n\n1. first\n2. second\n',
      screenshots: [
        { name: 'screenshot-1.png', url: 'https://github.com/user-attachments/assets/aaaa' },
        { name: 'screenshot-2.jpg', url: 'https://github.com/user-attachments/assets/bbbb' },
      ],
      context: full,
      client: 'android',
      version: '0.31 (build 431425)',
      submissionId: '01JBXYZ0000000000000000001',
    },
  },
  {
    name: 'no description, no context',
    input: {
      description: '',
      screenshots: [],
      context: { groups: [] },
      client: 'web',
      version: 'production',
      submissionId: '01JBXYZ0000000000000000002',
    },
  },
  {
    name: 'a version that tries to format',
    input: {
      description: 'x',
      screenshots: [],
      context: { groups: [] },
      client: 'mac',
      version: '1.2 @ryan #5 [link](http://e) <b>\n',
      submissionId: '01JBXYZ0000000000000000003',
    },
  },
];

/** `fieldGroup`'s cuts (A791): every value and name to `cell`, and at most `groupRows` rows. */
const fieldCases: Array<{
  name: string;
  fields: Array<[string, string]>;
}> = [
  {
    name: 'a long value',
    fields: [['Tags', Array.from({ length: 60 }, (_, i) => `#tag${i}`).join(', ')]],
  },
  {
    name: 'many rows',
    fields: Array.from({ length: 45 }, (_, i) => [`F${i}`, String(i)] as [string, string]),
  },
];

interface Contract {
  readonly limits: typeof FEEDBACK_LIMITS;
  readonly types: typeof FEEDBACK_TYPE_LABELS;
  readonly priorities: typeof FEEDBACK_PRIORITY_LABELS;
  readonly labels: Array<{ type: 'bug' | 'feature'; priority: 1 | 2 | 3 | 4; labels: string[] }>;
  readonly contexts: Array<{ name: string; context: FeedbackContext; markdown: string }>;
  readonly bodies: Array<{ name: string; input: FeedbackIssueInput; body: string }>;
  readonly fieldGroups: Array<{ name: string; fields: Array<[string, string]>; rows: string[][] }>;
}

function build(): Contract {
  return {
    limits: FEEDBACK_LIMITS,
    types: FEEDBACK_TYPE_LABELS,
    priorities: FEEDBACK_PRIORITY_LABELS,
    labels: (['bug', 'feature'] as const).flatMap((type) =>
      ([1, 2, 3, 4] as const).map((priority) => ({
        type,
        priority,
        labels: feedbackLabels(type, priority),
      })),
    ),
    contexts: contexts.map(({ name, context }) => ({
      name,
      context,
      markdown: contextMarkdown(context),
    })),
    bodies: bodies.map(({ name, input }) => ({ name, input, body: feedbackIssueBody(input) })),
    fieldGroups: fieldCases.map(({ name, fields }) => ({
      name,
      fields,
      rows: fieldGroup('note', fields).rows.map((row) => [...row]),
    })),
  };
}

describe('the feedback contract (feedback-v1.json)', () => {
  if (process.env['PENMOSS_WRITE_CONTRACTS'] === '1') {
    writeFileSync(FILE, `${JSON.stringify(build(), null, 2)}\n`);
  }
  const stored = JSON.parse(readFileSync(FILE, 'utf8')) as Contract;

  it('matches what core renders now', () => {
    expect(stored).toEqual(build());
  });

  it('covers every group and both empty forms', () => {
    const ids = new Set(stored.contexts.flatMap(({ context }) => context.groups.map((g) => g.id)));
    expect([...ids].sort()).toEqual(['app', 'edits', 'errors', 'note', 'sync', 'where']);
    expect(stored.contexts.some(({ markdown }) => markdown === '')).toBe(true);
  });
});
