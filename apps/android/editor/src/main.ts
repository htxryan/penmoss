/**
 * The Android editor page (T32): the shared editor, the web app's note
 * styles and theme tokens, and the bridge to the app. Loaded from the APK
 * through WebViewAssetLoader; the `penmossNative` listener exists only there.
 */
import '../../../web/src/theme/defaults.css';
import '../../../web/src/styles.css';
import '../../../web/src/blocks.css';
import '../../../web/src/links.css';
import './android.css';
import { EditorHost, type HostElements } from './host';
import { encodeFromEditor, type FromEditor } from './protocol';

interface NativePort {
  postMessage(message: string | ArrayBuffer): void;
  onmessage: ((event: { data: string }) => void) | null;
}

const port = (window as unknown as { penmossNative?: NativePort }).penmossNative;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The editor page has no #${id}`);
  return found as T;
}

const elements: HostElements = {
  root: element('note'),
  title: element<HTMLTextAreaElement>('title'),
  body: element('body'),
  unsupported: element('unsupported'),
};

const post = (message: FromEditor) => port?.postMessage(encodeFromEditor(message));
// A picture's bytes travel as an ArrayBuffer of their own (A304).
const postBytes = (bytes: Uint8Array<ArrayBuffer>) =>
  port?.postMessage(
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer,
  );
const host = new EditorHost(elements, post, { postBytes });
if (port) {
  port.onmessage = (event) => host.receive(String(event.data));
}
// Diagnostics through chrome://inspect: only on a debug build, which loads the page with ?debug.
if (new URLSearchParams(location.search).has('debug')) {
  (window as unknown as { penmossEditor?: EditorHost }).penmossEditor = host;
}
// The app may be stopped once in the background: send waiting edits first.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') host.flush();
});
window.addEventListener('pagehide', () => host.flush());
// The keyboard opening shrinks the WebView: keep the caret above the formatting bar (A307).
const viewport = window.visualViewport;
const resized = () => host.viewportChanged(viewport?.height ?? window.innerHeight);
viewport?.addEventListener('resize', resized);
window.addEventListener('resize', resized);
resized();
host.start();
