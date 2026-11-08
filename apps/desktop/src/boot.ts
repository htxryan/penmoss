/**
 * The app's entry (T54, A992): with `--penmoss-cli`, the binary is the `penmoss` CLI, and none
 * of the app starts; otherwise the app.
 */
import { CLI_FLAG } from './local-agents';

if (process.argv.includes(CLI_FLAG)) void import('./cli-mode');
else void import('./main');
