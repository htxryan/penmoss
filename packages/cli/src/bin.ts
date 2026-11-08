/**
 * The CLI as a program (dist/penmoss-cli.js, built by build.js). It is loaded
 * by dist/penmoss.js, which checks the Node version first (A174).
 */
import { killGitOnSignals } from '@penmoss/git-notebook/node';
import { run } from './main';
import { nodeIo } from './node-io';

// `penmoss cat … | head` closes the pipe early: that is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  throw error;
});

// A git notebook's git children die with the CLI, even when it is stopped by a signal.
killGitOnSignals();

process.exitCode = await run(process.argv.slice(2), nodeIo());
