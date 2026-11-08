/**
 * Search by meaning's utility process (T76, A1152): main forks `dist/embed-utility.cjs`, and this
 * serves a `MeaningService` on the parent port. The model runs here on onnxruntime-web's threaded
 * WASM from `dist/ort` (in app.asar), four threads, off every UI thread. `PENMOSS_HOME` is the
 * CLI's `~/.penmoss`, which main passes; `PENMOSS_MEANING_DOWNLOAD=0` (the Electron suite) never
 * downloads the model.
 */
import { join } from 'node:path';
import {
  MeaningService,
  NodeMeaning,
  serveService,
  serviceCalls,
  type EmbedPort,
} from '@penmoss/embed';

const home = process.env['PENMOSS_HOME'];
if (!home) throw new Error('PENMOSS_HOME is not set');
const parent = process.parentPort;
const port: EmbedPort = {
  postMessage: (message) => parent.postMessage(message),
  on: (_event, listener) => parent.on('message', (event) => listener(event.data)),
};
const service = new MeaningService(
  new NodeMeaning({ home, wasmPaths: join(__dirname, 'ort') }),
  (status) => port.postMessage({ status }),
  {
    download: process.env['PENMOSS_MEANING_DOWNLOAD'] !== '0',
    log: (text) => console.error(text),
  },
);
serveService(port, serviceCalls(service));
void service.start();
