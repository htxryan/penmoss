/** Opens the configured tracker (LD1), checked, for the daemon, a run, `factory:next` and the UI. */
import { expandHome, type FactoryConfig } from '../config.ts';
import type { Gh } from '../github.ts';
import { createGithubTracker } from './github.ts';
import { createLinearTracker } from './linear.ts';
import {
  appToken,
  createLinearClient,
  loadLinearCredentials,
  type LinearClient,
} from './linear-client.ts';
import type { Tracker } from './port.ts';

export type Opened = { ok: true; tracker: Tracker } | { ok: false; error: string };

/** The factory app's client, from the host-only `linear.env` (LD4). */
export function appClient(
  config: FactoryConfig,
): { ok: true; client: LinearClient } | { ok: false; error: string } {
  const loaded = loadLinearCredentials(expandHome(config.linear.envFile));
  if (!loaded.ok) return { ok: false, error: `the Linear app's credentials: ${loaded.error}` };
  return { ok: true, client: createLinearClient({ token: appToken(loaded.credentials) }) };
}

/** Checks that Linear can run the factory: Ryan's ID set, the app not Ryan, the states and Blocked. */
export async function openLinear(config: FactoryConfig, client: LinearClient): Promise<Opened> {
  if (!config.linear.owner)
    return {
      ok: false,
      error:
        "config.linear.owner is empty: `task factory:linear:check -- --me` prints Ryan's Linear user ID",
    };
  const tracker = createLinearTracker(config, client);
  const viewer = await client.request<{ viewer: { id: string; displayName: string } }>(
    'query { viewer { id displayName } }',
  );
  // The factory acts as its own app, never with Ryan's key: his words must stay his (R14, LD4).
  if (viewer.viewer.id === config.linear.owner)
    return {
      ok: false,
      error: "the Linear token in linear.env is Ryan's own; the factory needs its app's",
    };
  const team = await tracker.team();
  const s = config.status;
  const missing = [s.pick, s.planning, s.working, s.review, s.done].filter((n) => !team.states[n]);
  if (missing.length)
    return {
      ok: false,
      error: `Linear's ${config.linear.team} team has no state ${missing.map((m) => `"${m}"`).join(', ')} (task factory:linear:check)`,
    };
  if (!team.blockedLabel)
    return {
      ok: false,
      error: `Linear has no "${config.linear.blockedLabel}" label for ${config.linear.team} (task factory:linear:check)`,
    };
  return { ok: true, tracker };
}

export async function openTracker(config: FactoryConfig, gh: Gh): Promise<Opened> {
  if (config.tracker === 'github') return { ok: true, tracker: createGithubTracker(config, gh) };
  const app = appClient(config);
  if (!app.ok) return app;
  try {
    return await openLinear(config, app.client);
  } catch (error) {
    return {
      ok: false,
      error: `Linear: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
