/**
 * Search by meaning's IPC (T76): main and note windows search; the switch is the main window's,
 * after a click or key press (A1158). The page's notes and options are checked first.
 */
import { parseSearchOptions, parseServiceNotes } from '../embedding-service';
import type { IpcHandlers } from '../ipc';
import { meaning } from '../services';

export function registerMeaningIpc(ipc: IpcHandlers): void {
  ipc.handle('meaningStatus', () => meaning?.status() ?? null);
  ipc.handle('meaningUpdate', (_call, notebookId, notes) => {
    const parsed = parseServiceNotes(notes);
    if (typeof notebookId !== 'string' || !parsed) return [];
    return meaning?.update(notebookId, parsed) ?? [];
  });
  ipc.handle('meaningClose', async (_call, notebookId) => {
    if (typeof notebookId === 'string') await meaning?.close(notebookId);
  });
  ipc.handle('meaningSearch', (_call, notebookId, query, options) => {
    const parsed = parseSearchOptions(options);
    if (typeof notebookId !== 'string') return null;
    if (typeof query !== 'string' || query.length > 2_000 || !parsed) return null;
    return meaning?.search(notebookId, query, parsed) ?? null;
  });
  ipc.handle('meaningSetEnabled', (_call, on) =>
    typeof on === 'boolean' ? (meaning?.setEnabled(on) ?? null) : null,
  );
  ipc.handle('meaningRemoveModel', () => meaning?.removeModel() ?? null);
  ipc.handle('meaningRemoveIndex', () => meaning?.removeIndex() ?? null);
}
