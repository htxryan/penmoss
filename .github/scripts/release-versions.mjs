// Tags and app versions (P3, P5): pure, no `gh`. Used by releases.mjs and release-tag.mjs.

const BUILD = /^build-(\d+)$/;
/** A stable tag (P3, P5): vX.Y.Z, no suffix. */
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** A release tag (P3, R5): vX.Y.Z, or vX.Y.Z-rc.N for a rehearsal. */
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;

/** @param {string} tag @param {RegExp} [pattern] @returns {number | null} */
export function buildNumber(tag, pattern = BUILD) {
  const match = pattern.exec(tag);
  return match ? Number(match[1]) : null;
}

/**
 * The newest stable version among `tags` (P5), as [X, Y, Z], or null before the first. Tags
 * with a suffix (v0.2.0-rc.1, a rehearsal) and anything else are ignored.
 * @param {string[]} tags @returns {[number, number, number] | null}
 */
export function newestStable(tags) {
  /** @type {[number, number, number] | null} */
  let best = null;
  for (const tag of tags) {
    const match = STABLE_TAG.exec(tag);
    if (!match) continue;
    /** @type {[number, number, number]} */
    const version = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/**
 * Below zero, zero or above as version `a` is older than, the same as or newer than `b`.
 * @param {number[]} a @param {number[]} b
 */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The app version of main build `run` (P5): X.Y.(Z+1)-alpha.<run> after the newest stable tag
 * vX.Y.Z, else 0.2.0-alpha.<run>. It is newer than every 0.1.<run> build before it, older than
 * the next stable release, and goes up with the run.
 * @param {string[]} tags @param {number} run
 */
export function appVersion(tags, run) {
  if (!Number.isSafeInteger(run) || run < 1) throw new Error(`Not a build number: ${run}`);
  const stable = newestStable(tags);
  if (stable === null) return `0.2.0-alpha.${run}`;
  return `${stable[0]}.${stable[1]}.${stable[2] + 1}-alpha.${run}`;
}

/**
 * A Play bundle's version name (PEN-109, RN15): the alpha-style version of the newest main build
 * (its `build-N` tag), so a Play build places itself in the release notes as a sideload build
 * does. Its versionCode stays minute-based (A595).
 * @param {string[]} tags the v* tags @param {string[]} releases every release's tag
 */
export function playVersion(tags, releases) {
  const builds = releases.flatMap((tag) => {
    const match = BUILD.exec(tag);
    return match ? [Number(match[1])] : [];
  });
  if (builds.length === 0) throw new Error('No build-N release: set PENMOSS_VERSION_NAME.');
  return appVersion(tags, Math.max(...builds));
}

/**
 * A release tag's version (P3): vX.Y.Z is stable, vX.Y.Z-rc.N a rehearsal (a draft prerelease).
 * @param {string} tag
 * @returns {{ version: string, core: [number, number, number], prerelease: boolean } | null}
 */
export function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(tag);
  if (!match) return null;
  /** @type {[number, number, number]} */
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  return { version: tag.slice(1), core, prerelease: match[4] !== undefined };
}

/**
 * What release.yml needs to know about `tag` (P3): its version, whether it is a rehearsal, and
 * the newest stable tag before it (the notes start there). It refuses a tag that is not a release
 * tag, and one at or below an existing stable release, which would move Latest backwards.
 * @param {string} tag @param {string[]} tags
 */
export function releaseInfo(tag, tags) {
  const parsed = parseReleaseTag(tag);
  if (parsed === null) throw new Error(`${tag} is not vX.Y.Z or vX.Y.Z-rc.N.`);
  const others = tags.filter((t) => t !== tag && STABLE_TAG.test(t));
  const newest = newestStable(others);
  if (newest !== null && compareVersions(parsed.core, newest) <= 0) {
    throw new Error(`${tag} is not newer than the stable release v${newest.join('.')}.`);
  }
  return {
    version: parsed.version,
    prerelease: parsed.prerelease,
    previous: newest === null ? null : `v${newest.join('.')}`,
  };
}
