/**
 * The usage record's worker thread (PEN-137): bundled as `dist/analytics-worker.cjs` (build.mjs)
 * and started by main (`analytics-store.ts`). It opens `~/.penmoss/analytics/events.db` and
 * serves main's messages through `StoreHost`; SQLite never runs on the main thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { AnalyticsStore } from '@penmoss/core/analytics/node';
import { StoreHost, type HostData, type HostMessage } from './analytics-host';

const port = parentPort;
if (!port) throw new Error('analytics-worker runs as a worker thread');
const data = workerData as HostData;
const host = new StoreHost(
  AnalyticsStore.open(data.path),
  (reply) => port.postMessage(reply),
  data.limits,
  { onError: (message) => port.postMessage({ log: message }) },
);
port.on('message', (message: HostMessage) => host.handle(message));
