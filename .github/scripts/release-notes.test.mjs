// Release notes from pull requests (PEN-106, A1301) against an in-memory Releases page and pull
// requests: `task releases:test`.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  NOTES_FILE,
  alphaSection,
  emptyNotes,
  fixNote,
  notesSectionOf,
  publishNotes,
  readNotesFile,
  renderNotes,
  stableNotes,
  withNotesSection,
} from './release-notes.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'penmoss-notes-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const scratch = () => mkdtempSync(path.join(root, `s${++dirs}-`));

/** @param {string} note */
const body = (note) =>
  `## What and why\n\nStuff.\n\n## Release note\n\n${note}\n\n## How it was checked\n\nTests.`;

/** An in-memory Releases page, commit history and pull requests. */
class FakeGh {
  /** @type {import('./release-notes.mjs').Release[]} */
  releases = [
    {
      tag: 'alpha',
      target: 'c0',
      body: 'Penmoss Alpha: the newest build.',
      prerelease: true,
      assets: [],
    },
  ];
  /** Asset bytes by `tag/name`. @type {Map<string, string>} */
  files = new Map();
  /** Commits in order on main. @type {string[]} */
  history = ['c0'];
  /** @type {Map<string, import('./release-notes.mjs').PullRequest[]>} */
  pulls = new Map();
  /** @type {string[]} */
  logs = [];
  /** @type {string[]} */
  compared = [];

  /** Merges a pull request into `to` as commit `sha`. @param {string} sha @param {number} number @param {string} note */
  merge(sha, number, note, to = 'main') {
    this.history.push(sha);
    this.pulls.set(sha, [{ number, body: body(note), mergedTo: to }]);
  }
  /** Build `run` of `sha`, as publish-apk leaves it. @param {number} run @param {string} sha */
  build(run, sha) {
    this.releases.push({
      tag: `build-${run}`,
      target: sha,
      body: `Build ${run} from main.\n\n<!-- penmoss-mac -->\n### Mac`,
      prerelease: true,
      assets: [],
    });
  }
  /** @param {string} tag */
  release(tag) {
    const found = this.releases.find((r) => r.tag === tag);
    assert.ok(found, `no release ${tag}`);
    return found;
  }
  /** @param {string} [tag] */
  notes(tag = 'alpha') {
    const text = this.files.get(`${tag}/${NOTES_FILE}`);
    assert.ok(text, `no ${NOTES_FILE} on ${tag}`);
    return readNotesFile(text);
  }
  async list() {
    return structuredClone(this.releases);
  }
  async download(/** @type {string} */ tag, /** @type {string} */ name, /** @type {string} */ dir) {
    const text = this.files.get(`${tag}/${name}`);
    assert.ok(text !== undefined, `no ${name} on ${tag}`);
    const file = path.join(dir, name);
    writeFileSync(file, text);
    return file;
  }
  async upload(/** @type {string} */ tag, /** @type {string} */ file) {
    const release = this.release(tag);
    const name = path.basename(file);
    release.assets = [...release.assets.filter((a) => a.name !== name), { name }];
    this.files.set(`${tag}/${name}`, readFileSync(file, 'utf8'));
  }
  async editNotes(/** @type {string} */ tag, /** @type {string} */ notes) {
    this.release(tag).body = notes;
  }
  async compare(/** @type {string} */ base, /** @type {string} */ head) {
    this.compared.push(`${base}...${head}`);
    const from = this.history.indexOf(base);
    const to = this.history.indexOf(head);
    assert.ok(from !== -1 && to !== -1, `compare ${base}...${head}`);
    return this.history.slice(from + 1, to + 1);
  }
  async pullsOf(/** @type {string} */ sha) {
    return this.pulls.get(sha) ?? [];
  }
  async pull(/** @type {number} */ number) {
    for (const prs of this.pulls.values()) {
      const found = prs.find((pr) => pr.number === number);
      if (found) return found;
    }
    throw new Error(`no pull request #${number}`);
  }
  log(/** @type {string} */ message) {
    this.logs.push(message);
  }
}

const now = new Date('2026-11-12T10:00:00Z');

describe('publish-notes', () => {
  it("collects a build's pull request into the file, the build's notes and alpha's", async () => {
    const gh = new FakeGh();
    gh.build(1170, 'c0');
    gh.merge(
      'c1',
      140,
      'New: Settings → Updates shows what changed.\nFixed (Mac): The window keeps its size.',
    );
    gh.build(1171, 'c1');
    await publishNotes(gh, { run: 1171, sha: 'c1', dir: scratch(), now });

    const file = gh.notes();
    assert.equal(file.head, 'c1');
    assert.equal(file.generated, '2026-11-12T10:00:00.000Z');
    assert.deepEqual(file.prs, [{ pr: 140, build: 1171 }]);
    assert.deepEqual(file.notes, [
      {
        build: 1171,
        pr: 140,
        kind: 'new',
        platform: null,
        text: 'Settings → Updates shows what changed.',
      },
      { build: 1171, pr: 140, kind: 'fixed', platform: 'mac', text: 'The window keeps its size.' },
    ]);
    // The first build compares from the build release before it.
    assert.deepEqual(gh.compared, ['c0...c1']);

    const own = gh.release('build-1171').body;
    assert.match(
      own,
      /^<!-- penmoss-notes -->\n### What's new\n\n\*\*New\*\*\n\n- Settings → Updates shows what changed\. \(#140\)/,
    );
    assert.match(own, /\*\*Fixed\*\*\n\n- Mac: The window keeps its size\. \(#140\)/);
    // Its install text and Mac marker stay below, for publish-mac to rewrite.
    assert.match(own, /<!-- \/penmoss-notes -->\n\nBuild 1171 from main\.\n\n<!-- penmoss-mac -->/);

    const alpha = gh.release('alpha').body;
    assert.match(alpha, /### What's new since notes began/);
    assert.match(alpha, /- Settings → Updates shows what changed\. \(#140, build 1171\)/);
    assert.match(alpha, /Penmoss Alpha: the newest build\.$/);
  });

  it('collects several pull requests merged between two builds, docs-only merges included', async () => {
    const gh = new FakeGh();
    gh.build(1170, 'c0');
    await publishNotes(gh, { run: 1170, sha: 'c0', dir: scratch(), now });
    gh.merge('c1', 141, 'Improved: Search ranks titles first.');
    gh.merge('c2', 142, 'none');
    gh.merge('c3', 143, 'Fixed (Android): The keyboard no longer hides the last line.');
    gh.build(1172, 'c3');
    await publishNotes(gh, { run: 1172, sha: 'c3', dir: scratch(), now });

    const file = gh.notes();
    assert.deepEqual(gh.compared.at(-1), 'c0...c3');
    assert.deepEqual(
      file.prs.map(({ pr, build }) => [pr, build]),
      [
        [141, 1172],
        [142, 1172],
        [143, 1172],
      ],
    );
    assert.deepEqual(
      file.notes.map(({ pr, kind }) => [pr, kind]),
      [
        [141, 'improved'],
        [143, 'fixed'],
      ],
    );
  });

  it('says so when a build changes nothing people would notice', async () => {
    const gh = new FakeGh();
    gh.build(1170, 'c0');
    gh.merge('c1', 144, 'none');
    gh.build(1171, 'c1');
    await publishNotes(gh, { run: 1171, sha: 'c1', dir: scratch(), now });
    assert.match(gh.release('build-1171').body, /Nothing that people using Penmoss would notice\./);
    assert.match(gh.release('alpha').body, /Nothing yet\./);
  });

  it('counts a pull request without a usable Release note as none, with a warning', async () => {
    const gh = new FakeGh();
    gh.build(1170, 'c0');
    gh.history.push('c1');
    gh.pulls.set('c1', [
      { number: 120, body: 'Merged before the check existed.', mergedTo: 'main' },
    ]);
    gh.build(1171, 'c1');
    await publishNotes(gh, { run: 1171, sha: 'c1', dir: scratch(), now });
    assert.deepEqual(gh.notes().notes, []);
    assert.deepEqual(gh.notes().prs, [{ pr: 120, build: 1171 }]);
    assert.ok(gh.logs.some((l) => /^::warning::#120 has no usable Release note, so none:/.test(l)));
  });

  it('ignores a pull request merged into another branch (a stacked one)', async () => {
    const gh = new FakeGh();
    gh.build(1170, 'c0');
    gh.merge('c1', 145, 'New: A thing.', 'pen-104-release-note');
    gh.build(1171, 'c1');
    await publishNotes(gh, { run: 1171, sha: 'c1', dir: scratch(), now });
    assert.deepEqual(gh.notes().prs, []);
  });

  it('is the same after a re-run of the same build', async () => {
    const gh = new FakeGh();
    gh.build(1170, 'c0');
    gh.merge('c1', 140, 'New: A thing.');
    gh.build(1171, 'c1');
    await publishNotes(gh, { run: 1171, sha: 'c1', dir: scratch(), now });
    const once = {
      file: gh.files.get(`alpha/${NOTES_FILE}`),
      own: gh.release('build-1171').body,
      alpha: gh.release('alpha').body,
    };
    // The re-run finds the file's head at its own commit, so it reads only that commit.
    await publishNotes(gh, { run: 1171, sha: 'c1', dir: scratch(), now });
    assert.deepEqual(
      {
        file: gh.files.get(`alpha/${NOTES_FILE}`),
        own: gh.release('build-1171').body,
        alpha: gh.release('alpha').body,
      },
      once,
    );
  });

  it('lists only the notes since the newest stable release on alpha', async () => {
    const file = {
      ...emptyNotes(),
      releases: [{ version: '0.2.1', tag: 'v0.2.1', build: 1171, date: '2026-11-15' }],
      notes: [
        { build: 1171, pr: 1, kind: /** @type {const} */ ('new'), platform: null, text: 'Old.' },
        {
          build: 1172,
          pr: 2,
          kind: /** @type {const} */ ('fixed'),
          platform: null,
          text: 'Newer.',
        },
      ],
    };
    const text = alphaSection(file);
    assert.match(text, /### What's new since v0\.2\.1/);
    assert.doesNotMatch(text, /Old\./);
    assert.match(text, /- Newer\. \(#2, build 1172\)/);
  });

  it('waits for the alpha release when there is none yet', async () => {
    const gh = new FakeGh();
    gh.releases = [];
    await publishNotes(gh, { run: 1171, sha: 'c0', dir: scratch(), now });
    assert.ok(gh.logs.some((l) => l.startsWith('::warning::No alpha release yet')));
  });

  it("starts from the newest stable release's file when alpha has none", async () => {
    const gh = new FakeGh();
    const stable = {
      ...emptyNotes(),
      head: 'c0',
      prs: [{ pr: 9, build: 1100 }],
      notes: [
        { build: 1100, pr: 9, kind: /** @type {const} */ ('new'), platform: null, text: 'Kept.' },
      ],
    };
    gh.releases.push({
      tag: 'v0.2.1',
      target: 'c0',
      body: '',
      prerelease: false,
      assets: [{ name: NOTES_FILE }],
    });
    gh.files.set(`v0.2.1/${NOTES_FILE}`, JSON.stringify(stable));
    gh.merge('c1', 140, 'New: A thing.');
    gh.build(1171, 'c1');
    await publishNotes(gh, { run: 1171, sha: 'c1', dir: scratch(), now });
    assert.deepEqual(
      gh.notes().notes.map((n) => n.text),
      ['Kept.', 'A thing.'],
    );
  });
});

describe('stable releases (PEN-107)', () => {
  const file = {
    ...emptyNotes(),
    releases: [{ version: '0.2.0', tag: 'v0.2.0', build: 1170, date: '2026-11-08' }],
    notes: [
      { build: 1170, pr: 1, kind: /** @type {const} */ ('new'), platform: null, text: 'Old.' },
      { build: 1172, pr: 2, kind: /** @type {const} */ ('new'), platform: null, text: 'In it.' },
      { build: 1180, pr: 3, kind: /** @type {const} */ ('new'), platform: null, text: 'Later.' },
    ],
  };
  const release = { tag: 'v0.2.1', version: '0.2.1', build: 1175, date: '2026-11-20', repo: 'o/r' };

  it('takes the notes after the stable release before it, up to its own build', () => {
    const { body } = stableNotes(file, { ...release, previous: 'v0.2.0' });
    assert.match(body, /- In it\. \(#2\)/);
    assert.doesNotMatch(body, /Old\.|Later\./);
    assert.match(body, /compare\/v0\.2\.0\.\.\.v0\.2\.1$/);
  });

  it('takes every note up to its build when the release before it is in no file', () => {
    const { body } = stableNotes(file, { ...release, previous: 'v0.1.9' });
    assert.match(body, /- Old\./);
    assert.match(body, /- In it\./);
  });

  it('lists itself once, replacing an earlier draft of the same tag', () => {
    const once = stableNotes(file, { ...release, previous: 'v0.2.0' }).file;
    const again = stableNotes(once, { ...release, build: 1176, previous: 'v0.2.0' }).file;
    assert.deepEqual(
      again.releases.map((r) => [r.tag, r.build]),
      [
        ['v0.2.0', 1170],
        ['v0.2.1', 1176],
      ],
    );
  });

  it("teaches alpha's file a stable release once it is published", async () => {
    const gh = new FakeGh();
    gh.build(1170, 'c0');
    await publishNotes(gh, { run: 1170, sha: 'c0', dir: scratch(), now });
    // v0.2.1 is published, carrying its own file, which lists it.
    const theirs = stableNotes(gh.notes(), { ...release, previous: null }).file;
    gh.releases.push({
      tag: 'v0.2.1',
      target: 'c0',
      body: '',
      prerelease: false,
      assets: [{ name: NOTES_FILE }],
    });
    gh.files.set(`v0.2.1/${NOTES_FILE}`, JSON.stringify(theirs));
    gh.merge('c1', 150, 'New: After it.');
    gh.build(1176, 'c1');
    await publishNotes(gh, { run: 1176, sha: 'c1', dir: scratch(), now });
    assert.deepEqual(
      gh.notes().releases.map((r) => r.tag),
      ['v0.2.1'],
    );
    assert.match(gh.release('alpha').body, /### What's new since v0\.2\.1/);
  });
});

describe('fix-note', () => {
  /** #140 as the fake holds it. @param {FakeGh} gh */
  const pr140 = (gh) => {
    const pr = gh.pulls.get('c1')?.[0];
    assert.ok(pr);
    return pr;
  };
  /** A page where #140 (build 1171) was merged with a typo. */
  const typo = async () => {
    const gh = new FakeGh();
    gh.build(1170, 'c0');
    gh.merge('c1', 140, 'New: Setings shows what changed.');
    gh.build(1171, 'c1');
    await publishNotes(gh, { run: 1171, sha: 'c1', dir: scratch(), now });
    return gh;
  };

  it("puts a pull request's corrected note in place, at its own build", async () => {
    const gh = await typo();
    pr140(gh).body = body('New: Settings shows what changed.');
    await fixNote(gh, { pr: 140, dir: scratch(), now });
    assert.deepEqual(
      gh.notes().notes.map((n) => [n.build, n.text]),
      [[1171, 'Settings shows what changed.']],
    );
    assert.match(gh.release('build-1171').body, /- Settings shows what changed\. \(#140\)/);
    assert.doesNotMatch(gh.release('build-1171').body, /Setings/);
    assert.equal(notesSectionOf(gh.release('build-1171').body).match(/What's new/g)?.length, 1);
    assert.doesNotMatch(gh.release('alpha').body, /Setings/);
  });

  it('refuses a note that still does not parse, changing nothing', async () => {
    const gh = await typo();
    const before = gh.files.get(`alpha/${NOTES_FILE}`);
    pr140(gh).body = body('Changed: oops');
    await assert.rejects(fixNote(gh, { pr: 140, dir: scratch(), now }), /still doesn't parse/);
    assert.equal(gh.files.get(`alpha/${NOTES_FILE}`), before);
  });

  it('refuses a pull request in no build', async () => {
    const gh = await typo();
    await assert.rejects(fixNote(gh, { pr: 7, dir: scratch(), now }), /#7 is in no build's notes/);
  });
});

describe('the notes section', () => {
  it('goes first, is replaced in place, and survives a rewrite that keeps it', () => {
    const a = withNotesSection(
      'Install text.',
      '<!-- penmoss-notes -->\nA\n<!-- /penmoss-notes -->',
    );
    assert.equal(a, '<!-- penmoss-notes -->\nA\n<!-- /penmoss-notes -->\n\nInstall text.');
    const b = withNotesSection(a, '<!-- penmoss-notes -->\nB\n<!-- /penmoss-notes -->');
    assert.equal(b, '<!-- penmoss-notes -->\nB\n<!-- /penmoss-notes -->\n\nInstall text.');
    // publish-alpha writes alpha's text afresh, carrying the section over.
    assert.equal(
      withNotesSection('New alpha text.', notesSectionOf(b)),
      `${notesSectionOf(b)}\n\nNew alpha text.`,
    );
    assert.equal(
      withNotesSection('No notes yet.', notesSectionOf('No notes yet.')),
      'No notes yet.',
    );
  });

  it('groups notes New, Improved, Fixed', () => {
    const text = renderNotes([
      { build: 1, pr: 3, kind: 'fixed', platform: 'android', text: 'C.' },
      { build: 1, pr: 1, kind: 'new', platform: null, text: 'A.' },
      { build: 1, pr: 2, kind: 'improved', platform: null, text: 'B.' },
    ]);
    assert.equal(
      text,
      '**New**\n\n- A. (#1)\n\n**Improved**\n\n- B. (#2)\n\n**Fixed**\n\n- Android: C. (#3)',
    );
  });

  it('refuses a file with a newer schema rather than overwriting it', () => {
    assert.throws(() => readNotesFile('{"schema":2}'), /schema 2, not 1/);
  });
});
