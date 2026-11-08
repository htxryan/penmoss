import type { WorkspaceState } from './service';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The notice's words when changes a closed window kept as it went could not be merged (#116,
 * A676). The server's recovery of refused folder changes (A581) went with the server (T59).
 */
export function recoveredText(recovered: NonNullable<WorkspaceState['recovered']>): string {
  return `${plural(recovered.closed, 'folder change')} from a window that closed could not be kept.`;
}
