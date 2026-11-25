/**
 * The factory's LaunchAgents and logs from the command line (A15): `stop`, `logs`, `ui-open` and
 * `ui-tailnet`, which were shell in the Taskfile with the state folder and the launchd labels
 * written out. They read both from here instead: the state folder from the config
 * (`stateDir`), the labels from launchd.ts.
 */
import { join } from 'node:path';
import { expandHome, type FactoryConfig } from './config.ts';
import { LABEL, UI_LABEL } from './launchd.ts';

/** Runs a command with the terminal's own stdin, stdout and stderr; resolves to its exit code. */
type Interactive = (cmd: string, args: readonly string[]) => number;

export interface ControlDeps {
  readonly run: Interactive;
  readonly read: (file: string) => string;
  readonly uid: string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
}

const state = (config: FactoryConfig) => expandHome(config.stateDir);

/** Stops the daemon; runs in progress restart next time (R12). Not running is not a failure. */
export function stopDaemon(deps: ControlDeps): number {
  deps.run('launchctl', ['bootout', `gui/${deps.uid}/${LABEL}`]);
  return 0;
}

/** Follows the daemon's log, from its last 100 lines. */
export function followLogs(config: FactoryConfig, deps: ControlDeps): number {
  return deps.run('tail', ['-n', '100', '-f', join(state(config), 'daemon.log')]);
}

/** Opens the Factory UI in the browser, with the link (and its token) the running UI wrote. */
export function openUi(config: FactoryConfig, deps: ControlDeps): number {
  let url: string;
  try {
    url = deps.read(join(state(config), 'ui.url')).trim();
  } catch {
    deps.log("factory ui-open: the UI hasn't written its link (ui.url) yet: is it running?");
    return 1;
  }
  return deps.run('open', [url]);
}

/** The UI log's line that says the tailnet link, once the restarted UI has written it. */
export function tailnetLine(log: string): string | undefined {
  return log
    .split('\n')
    .filter((line) => line.includes('on the tailnet'))
    .at(-1);
}

/**
 * Serves the Factory UI on Ryan's tailnet (A1246): `tailscale serve` on 8443, never Funnel, then
 * restarts the UI so it accepts that name, and prints the link it logs.
 */
export async function serveOnTailnet(config: FactoryConfig, deps: ControlDeps): Promise<number> {
  const served = deps.run('tailscale', [
    'serve',
    '--bg',
    '--https=8443',
    `http://127.0.0.1:${config.ui.port}`,
  ]);
  if (served !== 0) return served;
  const restarted = deps.run('launchctl', ['kickstart', '-k', `gui/${deps.uid}/${UI_LABEL}`]);
  if (restarted !== 0) return restarted;
  await deps.sleep(2_000);
  let line: string | undefined;
  try {
    line = tailnetLine(deps.read(join(state(config), 'ui.log')));
  } catch {
    line = undefined;
  }
  deps.log(line ?? "The UI restarted, but ui.log doesn't name a tailnet link yet.");
  return 0;
}
