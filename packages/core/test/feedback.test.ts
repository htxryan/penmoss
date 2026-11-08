import { describe, expect, it } from 'vitest';
import {
  contextJson,
  contextMarkdown,
  contextWithoutSecrets,
  EDIT_COLUMNS,
  FEEDBACK_GROUP_IDS,
  FEEDBACK_LIMITS,
  feedbackIssueBody,
  feedbackLabels,
  fieldGroup,
  footerVersion,
  inertReferences,
  parseFeedbackContext,
  quotesNoteText,
  redactSecrets,
  redactText,
  REDACTED,
  withoutGroups,
  type FeedbackContext,
} from '../src/feedback';

const context: FeedbackContext = {
  groups: [
    fieldGroup('app', [
      ['Client', 'web'],
      ['Version', '1.2.3'],
      ['Keep on top', false],
      ['Missing', undefined],
    ]),
    {
      id: 'edits',
      columns: EDIT_COLUMNS,
      rows: [['2026-10-27T10:00:00Z', 'Mac', 'typed', '+2 −0 lines']],
    },
  ],
};

describe('feedback labels (A794)', () => {
  it('names the feedback label, the type and the priority', () => {
    expect(feedbackLabels('bug', 2)).toEqual(['in-app feedback', 'bug', 'P2']);
    expect(feedbackLabels('feature', 4)).toEqual(['in-app feedback', 'feature request', 'P4']);
  });
});

describe('the captured context as markdown (A791, A794)', () => {
  it('is a details block with a table per group, then the JSON copy', () => {
    const markdown = contextMarkdown(context);
    expect(markdown.startsWith('<details><summary>Captured context</summary>\n\n#### App')).toBe(
      true,
    );
    expect(markdown).toContain('| Field | Value |\n| --- | --- |\n| Client | web |');
    expect(markdown).toContain('| Keep on top | no |');
    expect(markdown).not.toContain('Missing');
    expect(markdown).toContain('#### Recent edits to this note');
    expect(markdown).toContain('| 2026-10-27T10:00:00Z | Mac | typed | +2 −0 lines |');
    expect(markdown.endsWith('```\n\n</details>')).toBe(true);
    const json = /```json\n([\s\S]*)\n```/.exec(markdown)?.[1];
    expect(JSON.parse(json!)).toEqual(contextJson(context));
    expect(contextJson(context)).toEqual({
      app: { Client: 'web', Version: '1.2.3', 'Keep on top': 'no' },
      edits: [{ Time: '2026-10-27T10:00:00Z', Actor: 'Mac', Kind: 'typed', Change: '+2 −0 lines' }],
    });
  });

  it('is empty when every group is left out', () => {
    expect(contextMarkdown({ groups: [] })).toBe('');
    expect(contextMarkdown(withoutGroups(context, new Set(['app', 'edits'])))).toBe('');
  });

  it('keeps a cell on one line, escapes pipes and never writes HTML', () => {
    const markdown = contextMarkdown({
      groups: [fieldGroup('where', [['Route', 'a|b\nc <img src=x> \\']])],
    });
    expect(markdown).toContain('| Route | a\\|b c &lt;img src=x> \\\\ |');
  });

  it('says None for a table with no rows', () => {
    expect(contextMarkdown({ groups: [{ id: 'errors', columns: ['Time'], rows: [] }] })).toContain(
      '#### Recent errors\n\n_None_',
    );
  });

  it('fences the JSON past any backticks in it', () => {
    const markdown = contextMarkdown({ groups: [fieldGroup('note', [['Title', 'a ```` b']])] });
    expect(markdown).toContain('`````json\n');
  });
});

describe('the issue body (A794)', () => {
  it('has the description, the screenshots, the context and the footer, in order', () => {
    const body = feedbackIssueBody({
      description: '**Broken** thing\n',
      screenshots: [
        { name: 'screenshot-1.png', url: 'https://github.com/user-attachments/assets/a' },
        { name: 'shot [2].jpg', url: 'https://github.com/user-attachments/assets/b' },
      ],
      context,
      client: 'mac',
      version: '0.9 (build 300)',
      submissionId: '01JBXYZ0000000000000000000',
    });
    const description = body.indexOf('**Broken** thing');
    const shot = body.indexOf('![screenshot-1.png](https://github.com/user-attachments/assets/a)');
    const details = body.indexOf('<details>');
    const footer = body.indexOf(
      'Sent from Penmoss Mac 0.9 (build 300) · submission 01JBXYZ0000000000000000000',
    );
    expect(description).toBe(0);
    expect(shot).toBeGreaterThan(description);
    expect(body).toContain('![shot 2.jpg](https://github.com/user-attachments/assets/b)');
    expect(details).toBeGreaterThan(shot);
    expect(footer).toBeGreaterThan(details);
    expect(body.endsWith('\n')).toBe(true);
  });

  it('leaves out an empty description and context', () => {
    expect(
      feedbackIssueBody({
        description: '  ',
        screenshots: [],
        context: { groups: [] },
        client: 'android',
        version: '',
        submissionId: 'X',
      }),
    ).toBe('Sent from Penmoss Android unknown · submission X\n');
  });
});

describe('parseFeedbackContext (the Worker checks what a client sent)', () => {
  it('takes a well-formed context', () => {
    expect(parseFeedbackContext(JSON.parse(JSON.stringify(context)))).toEqual(context);
  });

  it('refuses unknown or repeated groups, ragged rows, non-strings and oversized cells', () => {
    const ok = { id: 'app', columns: ['Field', 'Value'], rows: [['a', 'b']] };
    expect(parseFeedbackContext(null)).toBeNull();
    expect(parseFeedbackContext({ groups: 'x' })).toBeNull();
    expect(parseFeedbackContext({ groups: [{ ...ok, id: 'body' }] })).toBeNull();
    expect(parseFeedbackContext({ groups: [ok, ok] })).toBeNull();
    expect(parseFeedbackContext({ groups: [{ ...ok, rows: [['a']] }] })).toBeNull();
    expect(parseFeedbackContext({ groups: [{ ...ok, rows: [['a', 3]] }] })).toBeNull();
    expect(
      parseFeedbackContext({
        groups: [{ ...ok, rows: [['a', 'x'.repeat(FEEDBACK_LIMITS.cell + 1)]] }],
      }),
    ).toBeNull();
    expect(
      parseFeedbackContext({
        groups: [
          { ...ok, rows: Array.from({ length: FEEDBACK_LIMITS.groupRows + 1 }, () => ['a', 'b']) },
        ],
      }),
    ).toBeNull();
    expect(parseFeedbackContext({ groups: [] })).toEqual({ groups: [] });
  });

  it('knows six groups', () => {
    expect(FEEDBACK_GROUP_IDS).toEqual(['app', 'where', 'sync', 'note', 'edits', 'errors']);
  });
});

describe('long values and references (A791, A794)', () => {
  it('cuts a long value to the Worker’s cell limit, so the context is never refused', () => {
    const tags = Array.from({ length: 60 }, (_, i) => `#tag${i}`).join(', ');
    expect(tags.length).toBeGreaterThan(FEEDBACK_LIMITS.cell);
    const group = fieldGroup('note', [
      ['Tags', tags],
      ['x'.repeat(500), 'name too'],
    ]);
    for (const row of group.rows) {
      for (const value of row) expect(value.length).toBeLessThanOrEqual(FEEDBACK_LIMITS.cell);
    }
    expect(group.rows[0]![1]!.endsWith('…')).toBe(true);
    expect(parseFeedbackContext({ groups: [group] })).not.toBeNull();
    const many = fieldGroup(
      'app',
      Array.from({ length: 50 }, (_, i) => [`F${i}`, i] as const),
    );
    expect(many.rows).toHaveLength(FEEDBACK_LIMITS.groupRows);
    expect(parseFeedbackContext({ groups: [many] })).not.toBeNull();
  });

  it('makes mentions and cross-references inert in the tables, not in the JSON', () => {
    const markdown = contextMarkdown({
      groups: [fieldGroup('note', [['Tags', '#100, #home, @ryan, GH-7, mail a@b']])],
    });
    expect(markdown).toContain(
      '| Tags | #\u200d100, #home, @\u200dryan, GH\u200d-7, mail a@\u200db |',
    );
    expect(markdown).toContain('"Tags": "#100, #home, @ryan, GH-7, mail a@b"');
    expect(inertReferences('issue #12')).toBe('issue #\u200d12');
  });

  it('keeps the footer’s version to plain words', () => {
    expect(footerVersion('0.9 (web abc123)')).toBe('0.9 (web abc123)');
    expect(footerVersion('1.2 @ryan #5 [x](http://e) <b>')).toBe('1.2 ryan 5 x(http:e) b');
    expect(footerVersion(' \n ')).toBe('unknown');
    expect(footerVersion('9'.repeat(200))).toHaveLength(FEEDBACK_LIMITS.versionMax);
  });
});

describe('redactText (recent errors, A791)', () => {
  it('removes a query from relative and app URLs too', () => {
    expect(redactText('at /notes/01AB?q=secret#h and penmoss://note/1?x=secret ok')).toBe(
      'at /notes/01AB and penmoss://note/1 ok',
    );
    expect(redactText('at (/assets/index.js:1:2) a/b?c')).toBe('at (/assets/index.js:1:2) a/b?c');
  });

  it('removes tokens, credentials, emails, URL queries, quotations and known names', () => {
    const out = redactText(
      'Failed pmd_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG for ryan@example.com at https://api.penmoss.app/api/search?q=secret+plan#x: "Garden plan" in Shopping list, it\'s fine',
      ['Shopping list', 'ab'],
    );
    expect(out).not.toContain('pmd_');
    expect(out).not.toContain('ryan@example.com');
    expect(out).not.toContain('secret');
    expect(out).toContain('https://api.penmoss.app/api/search');
    expect(out).not.toContain('Garden plan');
    expect(out).not.toContain('Shopping list');
    expect(out).toContain(REDACTED);
    // An apostrophe is not a quotation.
    expect(out).toContain("it's fine");
  });

  it('drops what a JSON parse error quotes', () => {
    expect(redactText('Unexpected token at offset 3. JSON input: {"title":"x"}')).toBe(
      `Unexpected token at offset 3. JSON input: ${REDACTED}`,
    );
  });
});

describe('quotesNoteText (an error that quotes the note is dropped, A791)', () => {
  const note = 'Remember to water the tomatoes every second morning before work.';
  it('finds a long run of the note in a message', () => {
    expect(
      quotesNoteText('TypeError: bad value water the tomatoes every second morning', note),
    ).toBe(true);
    expect(quotesNoteText('Cannot read "the tomatoes" of undefined', note)).toBe(true);
  });
  it('lets an unrelated message through', () => {
    expect(quotesNoteText('TypeError: Cannot read properties of undefined (reading x)', note)).toBe(
      false,
    );
    expect(quotesNoteText('anything at all', '')).toBe(false);
  });
});

describe('redactSecrets (the Worker posts no token)', () => {
  it('removes Penmoss tokens and bearer credentials only', () => {
    expect(
      redactSecrets('use pma_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG or Bearer xyz, ryan@x.io'),
    ).toBe('use [token removed] or Bearer [token removed] ryan@x.io');
    expect(
      contextWithoutSecrets({
        groups: [fieldGroup('sync', [['Last sync error', '401 for pmd_abcdefghijklmnop']])],
      }).groups[0]!.rows,
    ).toEqual([['Last sync error', '401 for [token removed]']]);
  });

  it('removes GitHub tokens too, now that a device holds one (A1010)', () => {
    expect(
      redactSecrets(
        'ghp_abcdefghijklmnopqrstuvwxyz0123 and github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      ),
    ).toBe('[token removed] and [token removed]');
    expect(redactSecrets('ghp_short stays')).toBe('ghp_short stays');
  });
});
