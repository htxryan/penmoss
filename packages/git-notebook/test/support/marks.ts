/**
 * An agent writing an undo mark into its own clone's store, past every command (#174 merge
 * check): the probe the CLI's tests use, with the clone's own client id, as its engine writes.
 */
import * as Y from '@y/y';
import { FileStorage } from '../../src/node';

export async function markUndoneInStore(dir: string, commit: string, by: string): Promise<void> {
  const storage = new FileStorage(dir);
  const snapshot = await storage.load();
  if (!snapshot?.workspace) throw new Error(`no notebook stored in ${dir}`);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, snapshot.workspace);
    const own = snapshot.meta.clientId ?? snapshot.meta.ownClients.at(-1);
    if (own === undefined) throw new Error('the clone has no client id of its own');
    doc.clientID = own;
    doc.get('agentUndone').setAttr(commit, { at: Date.now(), by });
    await storage.save({
      workspace: Y.encodeStateAsUpdate(doc),
      notes: new Map(),
      meta: { ...snapshot.meta, workspaceDirty: true },
    });
  } finally {
    doc.destroy();
  }
}
