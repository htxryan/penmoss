/**
 * `factory stop`, `logs`, `ui-open` and `ui-tailnet` (A15): the state folder from the config and
 * the labels from launchd.ts, never written out. Nothing here runs launchctl, tail, open or
 * tailscale: the commands go to a recorder.
 */
import { describe, expect, it } from 'vitest';
import {
  followLogs,
  openUi,
  serveOnTailnet,
  stopDaemon,
  tailnetLine,
  type ControlDeps,
} from '../src/control.ts';
import { LABEL, UI_LABEL } from '../src/launchd.ts';
import { testConfig } from './helpers.ts';

function deps(files: Record<string, string> = {}, codes: Record<string, number> = {}) {
  const ran: string[] = [];
  const logged: string[] = [];
  const d: ControlDeps = {
    run: (cmd, args) => {
      ran.push([cmd, ...args].join(' '));
      return codes[cmd] ?? 0;
    },
    read: (file) => {
      const text = files[file];
      if (text === undefined) throw new Error(`ENOENT: ${file}`);
      return text;
    },
    uid: '501',
    sleep: () => Promise.resolve(),
    log: (line) => logged.push(line),
  };
  return { d, ran, logged };
}

const config = { ...testConfig(), stateDir: '/state' };

describe('the factory control commands', () => {
  it('stop boots out the daemon by its label, and a daemon not running is fine', () => {
    const { d, ran } = deps({}, { launchctl: 3 });
    expect(stopDaemon(d)).toBe(0);
    expect(ran).toEqual([`launchctl bootout gui/501/${LABEL}`]);
  });

  it("logs follows the configured state folder's daemon.log", () => {
    const { d, ran } = deps();
    expect(followLogs(config, d)).toBe(0);
    expect(ran).toEqual(['tail -n 100 -f /state/daemon.log']);
  });

  it("ui-open opens the link the UI wrote, and says so when there's none", () => {
    const opened = deps({ '/state/ui.url': 'http://127.0.0.1:7878/?token=t\n' });
    expect(openUi(config, opened.d)).toBe(0);
    expect(opened.ran).toEqual(['open http://127.0.0.1:7878/?token=t']);
    const none = deps();
    expect(openUi(config, none.d)).toBe(1);
    expect(none.ran).toEqual([]);
    expect(none.logged[0]).toMatch(/ui\.url/);
  });

  it("ui-tailnet serves the UI's port on 8443, restarts the UI, and prints its tailnet line", async () => {
    const log =
      'a\n2026 Factory UI on the tailnet: https://old\n2026 Factory UI on the tailnet: https://new\n';
    const { d, ran, logged } = deps({ '/state/ui.log': log });
    expect(await serveOnTailnet({ ...config, ui: { ...config.ui, port: 7979 } }, d)).toBe(0);
    expect(ran).toEqual([
      'tailscale serve --bg --https=8443 http://127.0.0.1:7979',
      `launchctl kickstart -k gui/501/${UI_LABEL}`,
    ]);
    expect(logged).toEqual(['2026 Factory UI on the tailnet: https://new']);
  });

  it('ui-tailnet stops at a failed tailscale serve, never restarting the UI', async () => {
    const { d, ran } = deps({}, { tailscale: 1 });
    expect(await serveOnTailnet(config, d)).toBe(1);
    expect(ran).toHaveLength(1);
    expect(tailnetLine('nothing here')).toBeUndefined();
  });
});
