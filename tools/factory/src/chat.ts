/**
 * A run's sessions' chats in the Claude app (A1287): each agent session (the implementation,
 * a validation, a review round, a CI repair) gets its own, and the card says where it is.
 */
import type { Tracker } from './tracker/port.ts';

export function chatComment(url: string): string {
  return `The agent's session has a chat in the Claude app, to watch it or steer it while it works: ${url}\n\nThe chat ends with the session's turn; the next session in this run gets a new one.`;
}

/** Comments the link on the card; a comment that fails is logged, never stops the run. */
export function postChat(
  tracker: Pick<Tracker, 'comment'>,
  issue: number,
  url: string,
  log: (line: string) => void,
): void {
  tracker.comment(issue, chatComment(url)).catch((error: unknown) => {
    log(`couldn't post the chat link: ${error instanceof Error ? error.message : String(error)}`);
  });
}
