/**
 * Which relay this is (PEN-195): the source commit and its date, put in by the build
 * (scripts/build.mjs, `--define`), or `development` under `wrangler dev` and the tests. The
 * relay's pages show it, so someone running a copy of the template can tell when theirs is old.
 */
declare const RELAY_VERSION: string | undefined;

export const relayVersion: string =
  typeof RELAY_VERSION === 'string' && RELAY_VERSION ? RELAY_VERSION : 'development';

/** The user docs' page on keeping a relay up to date. */
export const UPDATE_DOCS = 'https://penmoss.app/docs/agents/claude-ai/#update-your-relay';
