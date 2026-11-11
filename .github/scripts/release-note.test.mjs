// The pull request's Release note (PEN-104, A1294): `task workflows:test`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkEvent, parseReleaseNote, summary } from './release-note.mjs';

const HINT =
  '<!-- One line per user-facing change: New, Improved or Fixed, then (Mac) or (Android) if it is only there, a colon and a sentence. Or `none`. -->';

/** A PR body as the template leaves it, with `note` as the section's text. @param {string} note */
const body = (note) =>
  [
    '## What and why',
    '',
    'Something changes. Fixes PEN-1',
    '',
    '## Release note',
    '',
    HINT,
    '',
    note,
    '',
    '## How it was checked',
    '',
    'Tests.',
  ].join('\n');

describe('parseReleaseNote', () => {
  it('reads one note of each kind', () => {
    const result = parseReleaseNote(
      body(
        'New: Settings → Updates shows what changed.\nImproved: Search ranks titles first.\nFixed: Daily notes open on the right day.',
      ),
    );
    assert.deepEqual(result, {
      ok: true,
      none: false,
      notes: [
        { kind: 'new', platform: null, text: 'Settings → Updates shows what changed.' },
        { kind: 'improved', platform: null, text: 'Search ranks titles first.' },
        { kind: 'fixed', platform: null, text: 'Daily notes open on the right day.' },
      ],
      errors: [],
    });
  });

  it('reads a platform', () => {
    const result = parseReleaseNote(
      body('Fixed (Mac): The window keeps its size.\nNew (Android): A What’s new screen.'),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.notes.map(({ kind, platform }) => [kind, platform]),
      [
        ['fixed', 'mac'],
        ['new', 'android'],
      ],
    );
  });

  it('takes the kind and the platform in any case, and list bullets', () => {
    const result = parseReleaseNote(
      body('- fixed (mac): The window keeps its size.\n* NEW: A thing.'),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.notes.map(({ kind, platform, text }) => [kind, platform, text]),
      [
        ['fixed', 'mac', 'The window keeps its size.'],
        ['new', null, 'A thing.'],
      ],
    );
  });

  it('reads none, with or without a full stop, in backticks or not', () => {
    for (const note of ['none', 'None.', '`none`', '- none']) {
      assert.deepEqual(
        parseReleaseNote(body(note)),
        { ok: true, none: true, notes: [], errors: [] },
        note,
      );
    }
  });

  it('ignores the hint comment, also when it spans lines', () => {
    const result = parseReleaseNote(
      '## Release note\n\n<!-- one\nNew: not a note.\n-->\nFixed: A real one.\n',
    );
    assert.deepEqual(result.notes, [{ kind: 'fixed', platform: null, text: 'A real one.' }]);
  });

  it('reads Windows line endings', () => {
    const result = parseReleaseNote(
      body('New: A thing.\nFixed: Another.').replaceAll('\n', '\r\n'),
    );
    assert.equal(result.ok, true);
    assert.equal(result.notes.length, 2);
  });

  it('accepts "Release notes" and a level-3 heading, and the section at the end', () => {
    assert.equal(parseReleaseNote('### Release notes\nNew: A thing.').ok, true);
    assert.equal(parseReleaseNote('Intro\n\n## release note\n\nnone').none, true);
  });

  it('ends the section at a blank line, so trailers after it are not notes', () => {
    const result = parseReleaseNote(
      '## Release note\n\nFixed: A real one.\n\nFixes PEN-104\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n',
    );
    assert.deepEqual(result, {
      ok: true,
      none: false,
      notes: [{ kind: 'fixed', platform: null, text: 'A real one.' }],
      errors: [],
    });
    assert.equal(parseReleaseNote('## Release note\nnone\n\nFixes PEN-104').none, true);
  });

  it('skips a Release note shown as an example in fenced code', () => {
    const example = '```markdown\n## Release note\n\nNew: Only an example.\n```';
    assert.deepEqual(
      parseReleaseNote(`Intro\n\n${example}\n\n${body('Fixed: The real one.')}`).notes,
      [{ kind: 'fixed', platform: null, text: 'The real one.' }],
    );
    assert.equal(parseReleaseNote(`Intro\n\n${example}\n`).ok, false);
  });

  it('fails notes split by a blank line, rather than dropping the second block', () => {
    const result = parseReleaseNote(body('New: A thing.\n\nFixed: Another.'));
    assert.equal(result.ok, false);
    assert.match(
      result.errors[0],
      /one block of lines.*"Fixed: Another\." comes after a blank line/,
    );
  });

  it('fails a body without the section, or no body at all', () => {
    for (const text of [body('').replace('## Release note', '## Notes'), '', null, undefined]) {
      const result = parseReleaseNote(text);
      assert.equal(result.ok, false);
      assert.match(result.errors[0], /no "## Release note" section/);
    }
  });

  it('fails a section that holds only the hint', () => {
    const result = parseReleaseNote(body(''));
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /is empty: write a note, or `none`/);
  });

  it('fails an unknown kind, naming the line', () => {
    const result = parseReleaseNote(body('New: A thing.\nChanged: Something else.'));
    assert.equal(result.ok, false);
    assert.deepEqual(result.notes, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /^Line 2 \("Changed: Something else\."\)/);
    assert.match(result.errors[0], /New, Improved or Fixed/);
  });

  it('fails an unknown platform', () => {
    const result = parseReleaseNote(body('Fixed (Windows): A thing.'));
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /\(Mac\) or \(Android\)/);
  });

  it('fails a note without a full stop', () => {
    const result = parseReleaseNote(body('New: A thing'));
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /end with a full stop/);
  });

  it('fails a kind with no sentence', () => {
    const result = parseReleaseNote(body('New: .'));
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /a sentence after the colon/);
  });

  it('fails a note too long to read at a glance', () => {
    const result = parseReleaseNote(body(`New: ${'word '.repeat(60).trim()}.`));
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /200 characters or fewer \(this one is 300\)/);
  });

  it('fails none beside notes', () => {
    const result = parseReleaseNote(body('none\nNew: A thing.'));
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /`none` stands alone/);
  });

  it('reports every bad line, not just the first', () => {
    const result = parseReleaseNote(body('Oops\nNew: fine.\nAlso oops'));
    assert.equal(result.errors.length, 2);
    assert.match(result.errors[0], /^Line 1/);
    assert.match(result.errors[1], /^Line 3/);
  });
});

describe('summary', () => {
  it('lists the notes when they are good', () => {
    const text = summary(parseReleaseNote(body('Fixed (Mac): The window keeps its size.')));
    assert.match(text, /Release note: OK/);
    assert.match(text, /- Fixed \(Mac\): The window keeps its size\./);
  });

  it('says none', () => {
    assert.match(summary(parseReleaseNote(body('none'))), /`none`: no user-facing change/);
  });

  it('explains the format when it fails', () => {
    const text = summary(parseReleaseNote(body('Oops')));
    assert.match(text, /Release note: needs a fix/);
    assert.match(text, /Line 1/);
    assert.match(text, /New: Settings → Updates shows what changed in each version\./);
  });
});

describe('checkEvent', () => {
  /** @param {unknown} event */
  const run = (event) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-note-'));
    const eventPath = path.join(dir, 'event.json');
    const summaryPath = path.join(dir, 'summary.md');
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(summaryPath, '');
    const ok = checkEvent({ GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summaryPath });
    return { ok, summary: readFileSync(summaryPath, 'utf8') };
  };

  it('passes a pull request with a good note and writes the summary', () => {
    const { ok, summary: text } = run({ pull_request: { body: body('New: A thing.') } });
    assert.equal(ok, true);
    assert.match(text, /- New: A thing\./);
  });

  it('fails a pull request without one', () => {
    const { ok, summary: text } = run({ pull_request: { body: null } });
    assert.equal(ok, false);
    assert.match(text, /no "## Release note" section/);
  });

  it('refuses an event that is not a pull request', () => {
    assert.throws(() => run({ issue: {} }), /not a pull_request event/);
  });
});
