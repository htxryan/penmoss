// Tags and app versions (P3, P5): `task releases:test`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appVersion,
  newestStable,
  parseReleaseTag,
  playVersion,
  releaseInfo,
} from './release-versions.mjs';

describe('versions (P5)', () => {
  it('is 0.2.0-alpha.<run> before the first stable tag', () => {
    assert.equal(appVersion([], 1510), '0.2.0-alpha.1510');
    assert.equal(
      appVersion(['alpha', 'build-1509', 'v0.2.0-rc.1', 'android-build-3'], 1510),
      '0.2.0-alpha.1510',
    );
  });

  it('counts from the newest stable tag by version, not by name or order', () => {
    const tags = ['v0.9.9', 'v0.10.1', 'v0.2.0', 'v0.10.2-rc.1', 'v1.0', 'v01.2.3', 'alpha'];
    assert.deepEqual(newestStable(tags), [0, 10, 1]);
    assert.equal(appVersion(tags, 1600), '0.10.2-alpha.1600');
    // A Play bundle takes the newest main build's (PEN-109, RN15).
    assert.equal(
      playVersion(['v0.2.0'], ['build-1180', 'v0.2.0', 'build-1179', 'alpha']),
      '0.2.1-alpha.1180',
    );
    assert.throws(() => playVersion(['v0.2.0'], ['alpha', 'v0.2.0']), /No build-N release/);
    assert.equal(appVersion(['v0.2.0'], 1601), '0.2.1-alpha.1601');
    assert.equal(appVersion(['v1.4.9', 'v1.10.0'], 7), '1.10.1-alpha.7');
  });

  it('refuses a run that is not a positive whole number', () => {
    for (const run of [0, -1, 1.5, Number.NaN])
      assert.throws(() => appVersion([], run), /build number/);
  });
});

describe('stable release tags (P3, R5)', () => {
  it('reads vX.Y.Z as stable and vX.Y.Z-rc.N as a rehearsal, and nothing else', () => {
    assert.deepEqual(parseReleaseTag('v0.2.0'), {
      version: '0.2.0',
      core: [0, 2, 0],
      prerelease: false,
    });
    assert.deepEqual(parseReleaseTag('v0.2.0-rc.1'), {
      version: '0.2.0-rc.1',
      core: [0, 2, 0],
      prerelease: true,
    });
    for (const tag of [
      '0.2.0',
      'v0.2',
      'v0.2.0-beta.1',
      'v0.2.0-rc.0',
      'v01.2.0',
      'alpha',
      'v0.2.0 ',
    ]) {
      assert.equal(parseReleaseTag(tag), null, tag);
    }
  });

  it('release-info: the version, rehearsal or not, and the stable tag before it', () => {
    const tags = ['v0.2.0', 'v0.2.1-rc.1', 'v0.2.1', 'v0.3.0-rc.1'];
    assert.deepEqual(releaseInfo('v0.3.0-rc.1', tags), {
      version: '0.3.0-rc.1',
      prerelease: true,
      previous: 'v0.2.1',
    });
    assert.deepEqual(releaseInfo('v0.2.0', ['v0.2.0']), {
      version: '0.2.0',
      prerelease: false,
      previous: null,
    });
    assert.deepEqual(releaseInfo('v0.2.1', tags), {
      version: '0.2.1',
      prerelease: false,
      previous: 'v0.2.0',
    });
  });

  it('release-info refuses a tag at or below a stable release, or not a release tag', () => {
    assert.throws(
      () => releaseInfo('v0.2.0', ['v0.2.0', 'v0.2.1']),
      /not newer than the stable release v0\.2\.1/,
    );
    assert.throws(() => releaseInfo('v0.2.1-rc.2', ['v0.2.1']), /not newer/);
    assert.throws(() => releaseInfo('v0.2', []), /not vX\.Y\.Z/);
  });
});
