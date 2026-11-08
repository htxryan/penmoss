/**
 * GitHub's tracker (LD1, LD9): Project 8's cards and the repository's issues, through the bot's
 * `gh`. This is the factory's behaviour from before Linear, unchanged, behind the port.
 */
import { readBoard, setBlocked, setStatus, type ProjectBoard } from '../board.ts';
import type { FactoryConfig } from '../config.ts';
import type { Gh } from '../github.ts';
import { readIssue } from '../issue.ts';
import type { Tracker } from './port.ts';

export function createGithubTracker(
  config: FactoryConfig,
  gh: Gh,
): Tracker & { project(): Promise<ProjectBoard> } {
  // Writes need the project's field IDs: the last board read, or a fresh one.
  let last: ProjectBoard | undefined;
  const read = async () => (last = await readBoard(gh, config));
  const project = async () => last ?? (await read());
  const comment = async (n: number, body: string) => {
    await gh.run(['issue', 'comment', String(n), '--repo', config.repo, '--body-file', '-'], body);
  };
  return {
    name: 'github',
    owner: config.owner,
    project,
    readBoard: read,
    readIssue: (n) => readIssue(gh, config.repo, n),
    isBlocked: async (n) => (await read()).items.find((i) => i.number === n)?.blocked ?? false,
    comment,
    setStatus: async (item, status) => setStatus(gh, await project(), item, status),
    setBlocked: async (item) => setBlocked(gh, await project(), item),
    closeIssue: async (n, body) => {
      await gh.run(['issue', 'close', String(n), '--repo', config.repo, '--comment', body]);
    },
  };
}
