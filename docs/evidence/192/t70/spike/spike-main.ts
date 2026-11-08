// T70 spike (throwaway): `Penmoss --t70-spike` measures the embedder in this main process (as the
// CLI runs) and in a utilityProcess, then writes JSON to $PENMOSS_T70_OUT and quits.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, utilityProcess } from 'electron';
import { runEmbedBench, type BenchResult } from './embed-bench';

const modelDir = process.env.PENMOSS_T70_MODEL!;
const out = process.env.PENMOSS_T70_OUT!;
const ortDir = join(__dirname, 'ort');

function inUtility(threads: number): Promise<BenchResult> {
  return new Promise((resolve) => {
    const child = utilityProcess.fork(join(__dirname, 'embed-utility.cjs'), [], { serviceName: 'Penmoss embedding (T70 spike)' });
    child.on('message', (message: BenchResult) => { resolve(message); child.kill(); });
    child.on('exit', (code) => resolve({ where: 'utilityProcess', threads, error: `exited ${code}` } as BenchResult));
    child.postMessage({ modelDir, ortDir, threads });
  });
}

void (async () => {
  const results: BenchResult[] = [];
  for (const threads of (process.env.PENMOSS_T70_MAIN_THREADS ?? '1,4').split(',').map(Number)) results.push(await runEmbedBench(modelDir, ortDir, threads, 'main (as --penmoss-cli)'));
  await app.whenReady();
  for (const threads of [1, 4]) results.push(await inUtility(threads));
  writeFileSync(out, JSON.stringify({ electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged, dirname: __dirname, results }, null, 2));
  app.quit();
})();
