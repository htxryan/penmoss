import type { WorkspaceState } from './service';
import { counted } from '@penmoss/core/words';

/**
 * The notice's words when changes a closed window kept as it went could not be merged (#116,
 * A676). The server's recovery of refused folder changes (A581) went with the server (T59).
 */
export function recoveredText(recovered: NonNullable<WorkspaceState['recovered']>): string {
  return `${counted(recovered.closed, 'folder change')} from a window that closed could not be kept.`;
}
