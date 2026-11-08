// `task release -- X.Y.Z` (P3, A1189): its checks, and that only a real run tags and pushes.
// A fake git: nothing here touches a repository. Part of `task releases:test`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { release, releaseProblems } from './release-tag.mjs';

const HEAD = 'a'.repeat(40);
/** @type {import('./release-tag.mjs').TagState} */
const ready = {
  version: '0.2.1',
  branch: 'main',
  dirty: false,
  head: HEAD,
  upstream: HEAD,
  tags: ['v0.2.0', 'v0.2.1-rc.1'],
  remoteHasTag: false,
};

describe('the checks before tagging', () => {
  it('passes on a clean main at origin/main with a new, newer version', () => {
    assert.deepEqual(releaseProblems(ready), []);
    assert.deepEqual(releaseProblems({ ...ready, version: '0.3.0-rc.1' }), []);
    assert.deepEqual(releaseProblems({ ...ready, tags: [], version: '0.2.0' }), []);
  });

  it('refuses another branch, a dirty checkout, or a HEAD that is not origin/main', () => {
    assert.match(releaseProblems({ ...ready, branch: 'feature' }).join(), /on feature, not main/);
    assert.match(releaseProblems({ ...ready, dirty: true }).join(), /uncommitted/);
    assert.match(
      releaseProblems({ ...ready, upstream: 'b'.repeat(40) }).join(),
      /is not origin\/main/,
    );
  });

  it('refuses a tag that exists here or on origin', () => {
    assert.match(
      releaseProblems({ ...ready, version: '0.2.1-rc.1' }).join(),
      /already exists here/,
    );
    assert.match(
      releaseProblems({ ...ready, remoteHasTag: true }).join(),
      /already exists on origin/,
    );
  });

  it('refuses a version that is not newer than the newest stable one', () => {
    assert.match(
      releaseProblems({ ...ready, version: '0.2.0' }).join(),
      /not newer than the newest stable release, v0\.2\.0/,
    );
    assert.match(releaseProblems({ ...ready, version: '0.1.9' }).join(), /not newer/);
    assert.match(releaseProblems({ ...ready, version: '0.2.0-rc.2' }).join(), /not newer/);
  });

  it('refuses something that is not a version', () => {
    for (const version of ['0.2', 'v0.2.1', '0.2.1-beta.1', '0.2.1-rc.0', 'latest']) {
      assert.match(releaseProblems({ ...ready, version }).join(), /is not X\.Y\.Z/, version);
    }
  });
});

/** A git that answers from `state` and records every call. @param {Partial<import('./release-tag.mjs').TagState>} [over] */
function fakeGit(over = {}) {
  const state = { ...ready, ...over };
  /** @type {string[][]} */
  const calls = [];
  /** @param {string[]} args */
  const git = (args) => {
    calls.push(args);
    const command = args.join(' ');
    if (command === 'rev-parse --abbrev-ref HEAD') return `${state.branch}\n`;
    if (command === 'status --porcelain') return state.dirty ? ' M Taskfile.yml\n' : '';
    if (command === 'rev-parse HEAD') return `${state.head}\n`;
    if (command === 'rev-parse origin/main') return `${state.upstream}\n`;
    if (command === 'tag --list v*') return state.tags.map((t) => `${t}\n`).join('');
    if (args[0] === 'ls-remote')
      return state.remoteHasTag ? `${HEAD}\trefs/tags/v${state.version}\n` : '';
    return '';
  };
  return { git, calls };
}

/** The calls that change something: making a tag, or any push. Listing tags is a read. */
const changed = (/** @type {string[][]} */ calls) =>
  calls.filter(([c, option]) => (c === 'tag' && option !== '--list') || c === 'push');

describe('task release', () => {
  it('fetches (forcing the moved alpha tag), then tags HEAD annotated and pushes only that tag', () => {
    const { git, calls } = fakeGit();
    release({ version: '0.2.1', git, log: () => {} });
    assert.deepEqual(calls[0], ['fetch', '--quiet', '--force', '--tags', 'origin', 'main']);
    assert.deepEqual(changed(calls), [
      ['tag', '--annotate', 'v0.2.1', '--message', 'Penmoss 0.2.1', HEAD],
      ['push', 'origin', 'refs/tags/v0.2.1'],
    ]);
  });

  it('a dry run checks the same and changes nothing', () => {
    const { git, calls } = fakeGit();
    /** @type {string[]} */
    const lines = [];
    release({ version: '0.2.1', dryRun: true, git, log: (line) => lines.push(line) });
    assert.deepEqual(changed(calls), []);
    assert.ok(lines.some((l) => l === `[dry run] git push origin refs/tags/v0.2.1`));
    assert.match(lines.at(-1) ?? '', /nothing was tagged or pushed/);
  });

  it('refuses before tagging anything, and says every reason', () => {
    const { git, calls } = fakeGit({ branch: 'feature', dirty: true });
    assert.throws(
      () => release({ version: '0.2.1', git, log: () => {} }),
      (error) =>
        error instanceof Error &&
        /on feature/.test(error.message) &&
        /uncommitted/.test(error.message),
    );
    assert.deepEqual(changed(calls), []);
  });
});
