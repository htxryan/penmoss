/**
 * This app's binary as the `penmoss` CLI (T54, A992): `Penmoss --penmoss-cli <args>` runs the
 * CLI with the person's arguments, stdin and stdout, and exits with its code. No window, no Dock
 * icon, no single-instance lock and none of the app's data: it is the CLI, with the CLI's own
 * files (`~/.penmoss`, its keychain items). Electron's run-as-Node fuse stays off (A224), so the
 * binary runs only this code, never a script someone hands it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { killGitOnSignals, nodeIo, run } from '@penmoss/cli/node';
import { NodeMeaning } from '@penmoss/embed';
import { CLI_FLAG } from './local-agents';

app.dock?.hide();
// Chromium's own log lines (a helper process starting as the CLI exits) are not the CLI's output.
app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('disable-gpu');

// `penmoss cat … | head` closes the pipe early: that is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  else throw error;
});

// A git notebook's git children die with the CLI, even when it is stopped by a signal.
killGitOnSignals();

const at = process.argv.indexOf(CLI_FLAG);
// How to run the CLI again, for a sync detached to outlive this run: the arguments up to the
// switch (in development, the app's folder first).
const self = process.argv.slice(1, at + 1).map((arg) => (arg === '.' ? app.getAppPath() : arg));

// Search by meaning (T75, A1152): onnxruntime-web's WASM and the embedding worker are bundled
// beside this file (dist/ort, dist/embed-worker.cjs), inside app.asar.
const meaning = new NodeMeaning({
  home: process.env['PENMOSS_HOME'] || join(homedir(), '.penmoss'),
  wasmPaths: join(__dirname, 'ort'),
  workerPath: join(__dirname, 'embed-worker.cjs'),
});

void run(process.argv.slice(at + 1), nodeIo({ self, meaning })).then(
  (code) => app.exit(code),
  (error: unknown) => {
    process.stderr.write(`penmoss: ${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  },
);
