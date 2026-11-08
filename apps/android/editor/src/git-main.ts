/**
 * The git engine page (T50 G7, A872): `git.html?role=engine` runs one notebook's engine and notes
 * server, `git.html?role=guard` the app's commit check (A876). Each talks only to the app, over
 * `penmossNative` with binary frames; without that bridge it does nothing.
 */
import { engineDbName, idbEngineKv } from '../../../web/src/sources/engine-store';
import { nativePort } from './git/channel';
import { serveEngine, serveGuard } from './git/page';

const port = nativePort();
const role = new URLSearchParams(location.search).get('role');
// The page speaks first ('ready'): the app answers on the reply port that first message brings
// (WebViewCompat's web message listener), and calls nothing before it.
if (port && role === 'guard') {
  serveGuard(port).emit('ready');
} else if (port && role === 'engine') {
  serveEngine(port, {
    open: (notebookId) => idbEngineKv(engineDbName(notebookId)),
    forget: (notebookId) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(engineDbName(notebookId));
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('Could not delete the store'));
        // Another connection (a page closing) still holds it: deleted once it lets go.
        request.onblocked = () => resolve();
      }),
  }).emit('ready');
}
