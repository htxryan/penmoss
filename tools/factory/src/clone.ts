/**
 * The runs' clone (`<stateDir>/repo`): cloned once, with a dead-end push URL, so a plain `git push`
 * from a worktree goes nowhere (A1230). The host pushes from the publish repo (publish.ts).
 */
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expandHome, type FactoryConfig } from './config.ts';
import type { Exec } from './exec.ts';
import { ensureConfig, mustGit } from './git.ts';
import { ensurePublishRepo, githubUrl } from './publish.ts';

export const DEAD_END_PUSH_URL = 'no-push://the-factory-harness-pushes';

export function repoDir(config: FactoryConfig): string {
  return join(expandHome(config.stateDir), 'repo');
}

/**
 * Clones the runs' clone once, gives it a dead-end push URL and, when given, the app's identity
 * for the commits made in it (`openFactory` sets it once; the worktrees share it), then makes the
 * publish repo and fetches main there (A1230). git never runs in the clone after its `clone`:
 * its config is written as a file (sandboxes see that file read-only), and its main is fetched
 * by each sandbox as it starts and again before each rebase (`sandboxStartCommand`).
 */
export async function ensureClone(
  config: FactoryConfig,
  exec: Exec,
  identity?: { readonly name: string; readonly email: string },
): Promise<string> {
  const dir = repoDir(config);
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  if (!existsSync(join(dir, '.git')))
    await mustGit(exec, parent, ['clone', '--quiet', githubUrl(config), dir]);
  const dotGit = lstatSync(join(dir, '.git'));
  const file = join(dir, '.git', 'config');
  if (!dotGit.isDirectory() || !lstatSync(file).isFile())
    throw new Error(
      `${dir} isn't a clone the factory made (its .git isn't a folder with a config)`,
    );
  const set = (key: string, value: string) => ensureConfig(exec, parent, key, value, file);
  await set('remote.origin.pushurl', DEAD_END_PUSH_URL);
  if (identity) {
    await set('user.name', identity.name);
    await set('user.email', identity.email);
  }
  await ensurePublishRepo(config, exec, identity);
  return dir;
}
