/**
 * The app's entry (T54, A992): with `--penmoss-cli`, the binary is the `penmoss` CLI, and none
 * of the app starts; otherwise the app, whose logging never fails on a closed stdout or stderr
 * (PEN-122, A1338). The CLI handles its own closed stdout (cli-mode.ts).
 */
import { CLI_FLAG } from './local-agents';
import { ignoreClosedOutput } from './stdio';

if (process.argv.includes(CLI_FLAG)) void import('./cli-mode');
else {
  ignoreClosedOutput();
  void import('./main');
}
