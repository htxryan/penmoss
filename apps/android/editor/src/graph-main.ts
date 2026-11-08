/**
 * The Android graph page (T40 P7, LK7, LK8; A478): the web's graph under touch,
 * fed by the app over `penmossNative`. Loaded from the APK through
 * WebViewAssetLoader beside the editor page, with the same CSP.
 */
import '../../../web/src/theme/defaults.css';
import '../../../web/src/graph/graph.css';
import './graph.css';
import { GraphHost } from './graph-host';
import { encodeFromGraph, type FromGraph } from './graph-protocol';

interface NativePort {
  postMessage(message: string): void;
  onmessage: ((event: { data: string }) => void) | null;
}

const port = (window as unknown as { penmossNative?: NativePort }).penmossNative;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`The graph page has no #${id}`);
  return found as T;
}

const host = new GraphHost(
  {
    root: element('graph'),
    canvas: element<HTMLCanvasElement>('canvas'),
    chip: element<HTMLButtonElement>('chip'),
    empty: element('empty'),
  },
  (message: FromGraph) => port?.postMessage(encodeFromGraph(message)),
);
if (port) port.onmessage = (event) => host.receive(String(event.data));
// Diagnostics through chrome://inspect: only on a debug build, which loads the page with ?debug.
if (new URLSearchParams(location.search).has('debug')) {
  (window as unknown as { penmossGraph?: GraphHost }).penmossGraph = host;
}
host.start();
