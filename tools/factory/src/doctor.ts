/**
 * `task factory:doctor` (F17, #262): starts one slot's sandbox on a throwaway branch and checks
 * that the toolchain works there and that what must stay out does. Each check says what it
 * proves; a failure is loud and names the check. Commands never print a secret: the isolation
 * checks open files for zero bytes, and the token checks print only an account name.
 */
import type { FactoryConfig, SlotConfig } from './config.ts';
import type { SecretKey } from './secrets.ts';
import { withJavaHome } from './sandbox.ts';

export interface Check {
  readonly name: string;
  readonly command: string;
  /** `pass`: must exit 0. `refused`: must exit non-zero (isolation). */
  readonly expect: 'pass' | 'refused';
  /** When given, stdout must contain this. */
  readonly output?: string;
  /** Tokens the check needs; it is skipped, and reported as such, without them. */
  readonly needs?: readonly SecretKey[];
  /** Minutes rather than seconds: only with `--full`. */
  readonly slow?: boolean;
  /** Every other check needs it, so it runs even with `--only`. */
  readonly setup?: boolean;
  /** Made on the host first: the slot's Android virtual device (F8). */
  readonly needsAvd?: boolean;
}

/** Opens a file for zero bytes: fails when the sandbox refuses it, and never prints contents. */
const opens = (path: string) => `head -c 0 '${path}'`;

export function doctorChecks(config: FactoryConfig, slot: SlotConfig, home: string): Check[] {
  const relay = 'apps/relay';
  const worker = 20000 + 100 * slot.portBlock + 87;
  const inspector = 20000 + 100 * slot.portBlock + 29;
  return [
    // The toolchain.
    {
      name: 'pnpm install',
      expect: 'pass',
      setup: true,
      command: 'corepack pnpm install --frozen-lockfile',
    },
    {
      name: 'typecheck (factory)',
      expect: 'pass',
      command: 'corepack pnpm --filter @penmoss/factory typecheck',
    },
    {
      name: 'unit tests (core)',
      expect: 'pass',
      command: 'corepack pnpm --filter @penmoss/core test',
    },
    {
      name: 'headless Chromium starts',
      expect: 'pass',
      output: 'chromium ok',
      command: `cd apps/web && corepack pnpm exec node -e "require('@playwright/test').chromium.launch().then(async (b) => { await b.close(); console.log('chromium ok'); })"`,
    },
    {
      name: 'JDK',
      expect: 'pass',
      command: 'java -version 2>&1 | head -1 && "$JAVA_HOME/bin/java" -version',
    },
    {
      // git-notebook's lock tells a stale holder by the boot time, from the sysctl command.
      name: 'sysctl kern.boottime (the notebook lock)',
      expect: 'pass',
      output: 'sec =',
      command: '/usr/sbin/sysctl -n kern.boottime',
    },
    {
      name: 'wrangler dev --local on the slot block',
      expect: 'pass',
      output: 'listening',
      command: `cd ${relay} && (corepack pnpm exec wrangler dev --local --port ${worker} --inspector-port ${inspector} > "$TMPDIR/wd.log" 2>&1 &) && for i in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:${worker}/" && echo listening && break; sleep 1; done; pkill -f "wrangler dev --local --port ${worker}" || true`,
    },
    {
      name: 'task check',
      expect: 'pass',
      slow: true,
      command: 'task check',
    },
    {
      name: 'task e2e -- smoke.spec.ts on the slot block',
      expect: 'pass',
      slow: true,
      command: 'task e2e -- smoke.spec.ts',
    },
    {
      name: 'task android:test',
      expect: 'pass',
      slow: true,
      command: withJavaHome('task android:test'),
    },
    // The Android proof (F8): the slot's own emulator boots headless, runs one instrumented
    // test with screenrecord running, and leaves a video and a screenshot. One test method, so
    // the check is about the recorder, not the app (the class's list test is #339).
    {
      name: "task proof:android (the slot's emulator, recorded)",
      expect: 'pass',
      slow: true,
      needsAvd: true,
      output: '"status":"passed"',
      command: withJavaHome(
        'task proof:android -- app.penmoss.editor.TypingInstrumentedTest#keyEventsWriteTheParagraphExactly && test -s apps/android/build/proof/android-1.mp4 && test -s apps/android/build/proof/android-1.png && cat apps/android/build/proof/report.json',
      ),
    },
    // Fails until Command Line Tools' compiler matches their SDK (F0.4): the owner check is then
    // left out of the build.
    {
      name: 'task desktop:build (Swift owner check)',
      expect: 'pass',
      slow: true,
      command: 'task desktop:build',
    },

    // The tokens (FD23).
    {
      name: `gh acts as ${config.publisher.login}`,
      expect: 'pass',
      output: config.publisher.login,
      needs: ['GH_TOKEN'],
      command: 'gh api user --jq .login',
    },
    {
      name: 'wrangler whoami shows the Penmoss account',
      expect: 'pass',
      needs: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
      command: `cd ${relay} && corepack pnpm exec wrangler whoami 2>&1 | grep -i "account" | grep -v -i token`,
    },

    // What stays out.
    {
      name: "Ryan's gh login is unreadable",
      expect: 'refused',
      command: opens(`${home}/.config/gh/hosts.yml`),
    },
    { name: '~/.ssh is unreadable', expect: 'refused', command: `ls '${home}/.ssh' > /dev/null` },
    {
      name: 'the login keychain is unreadable',
      expect: 'refused',
      command: opens(`${home}/Library/Keychains/login.keychain-db`),
    },
    {
      name: "Ryan's home is not writable",
      expect: 'refused',
      command: `touch '${home}/.factory-doctor-probe'`,
    },
    {
      name: 'a relay deploy is refused',
      expect: 'refused',
      command: `corepack pnpm --filter @penmoss/relay run deploy --dry-run`,
    },
  ];
}

export interface CheckOutcome {
  readonly check: Check;
  readonly status: 'ok' | 'failed' | 'skipped';
  readonly detail: string;
  readonly seconds: number;
}

/** Whether a finished command meets its check. */
export function judge(
  check: Check,
  exitCode: number,
  stdout: string,
): { ok: boolean; detail: string } {
  if (check.expect === 'refused') {
    return exitCode === 0
      ? { ok: false, detail: 'succeeded, but the sandbox must refuse it' }
      : { ok: true, detail: `refused (exit ${exitCode})` };
  }
  if (exitCode !== 0) return { ok: false, detail: `exit ${exitCode}` };
  if (check.output !== undefined && !stdout.includes(check.output)) {
    return { ok: false, detail: `output lacks "${check.output}"` };
  }
  return { ok: true, detail: 'passed' };
}

export function report(outcomes: readonly CheckOutcome[]): string {
  const mark = { ok: '✓', failed: '✗', skipped: '–' } as const;
  const lines = outcomes.map(
    (o) =>
      `${mark[o.status]} ${o.check.name}: ${o.detail}${o.status === 'skipped' ? '' : ` (${o.seconds.toFixed(0)} s)`}`,
  );
  const failed = outcomes.filter((o) => o.status === 'failed').length;
  const skipped = outcomes.filter((o) => o.status === 'skipped').length;
  lines.push(
    '',
    failed === 0
      ? `All checks passed${skipped ? `, ${skipped} skipped` : ''}.`
      : `${failed} check(s) FAILED.`,
  );
  return lines.join('\n');
}
