// T70 spike: the embedding service's process (Electron utilityProcess).
import { runEmbedBench } from './embed-bench';

process.parentPort.on('message', async (event: { data: { modelDir: string; ortDir: string; threads: number } }) => {
  const { modelDir, ortDir, threads } = event.data;
  process.parentPort.postMessage(await runEmbedBench(modelDir, ortDir, threads, 'utilityProcess'));
});
