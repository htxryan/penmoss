/**
 * `task factory:doctor` (F17, #262): starts one slot's sandbox on a throwaway branch and checks
 * that the toolchain works there and that what must stay out does. Each check says what it
 * proves; a failure is loud and names the check. Commands never print a secret: the isolation
 * checks open files for zero bytes, and the token checks print only an account name.
 */
import { expandHome, type FactoryConfig, type SlotConfig } from './config.ts';
import type { SecretKey } from './secrets.ts';
import { withJavaHome } from './sandbox.ts';

export interface Check {
  readonly name: string;
  readonly command: string;
  /** `pass`: must exit 0. `refused`: must exit non-zero (isolation). */
  readonly expect: 'pass' | 'refused';
  /**
   * When given, stdout must contain this. For a `refused` check it is the refusal itself, so a
   * command that fails for another reason doesn't pass as refused.
   */
  readonly output?: string;
  /** Tokens the check needs; it is skipped, and reported as such, without them. */
  readonly needs?: readonly (SecretKey | 'GH_TOKEN')[];
  /** Minutes rather than seconds: only with `--full`. */
  readonly slow?: boolean;
  /** Every other check needs it, so it runs even with `--only`. */
  readonly setup?: boolean;
  /** Made on the host first: the slot's Android virtual device (F8). */
  readonly needsAvd?: boolean;
}

/** What the repo's deploy commands say inside a run (FD24): `Taskfile.yml`, `apps/relay`. */
const DEPLOY_REFUSED = 'No production deploys from a factory run';

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
      name: `gh reads ${config.repo} with the app's read-only token`,
      expect: 'pass',
      output: config.repo,
      needs: ['GH_TOKEN'],
      command: `gh api repos/${config.repo} --jq .full_name`,
    },
    {
      // The branch GitHub refused live (A1222). A zero SHA, so a token that could write gets 422
      // and still creates nothing; the check then fails, since only a 403 is the refusal.
      name: `the app's read-only token can't write to ${config.repo} (A1222)`,
      expect: 'refused',
      output: 'HTTP 403',
      needs: ['GH_TOKEN'],
      command: `gh api -X POST repos/${config.repo}/git/refs -f ref=refs/heads/factory-doctor-probe -f sha=0000000000000000000000000000000000000000 2>&1`,
    },
    {
      name: 'Claude Code signs in with the setup token',
      expect: 'pass',
      output: 'factory-ok',
      needs: ['CLAUDE_CODE_OAUTH_TOKEN'],
      command: `ENABLE_CLAUDEAI_MCP_SERVERS=false ${config.agents.claude.bin} -p 'Reply with exactly: factory-ok' --model haiku --max-turns 1 --output-format text`,
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
      // Where the Mac app keeps git-secrets.json, its notebooks' tokens (F13's red-team target).
      name: "the Mac app's data folder (git-secrets.json) is unreadable",
      expect: 'refused',
      command: `ls '${home}/Library/Application Support/Penmoss' > /dev/null`,
    },
    {
      name: "the GitHub App's key file is unreadable (A1222)",
      expect: 'refused',
      command: opens(expandHome(config.publisher.envFile, home)),
    },
    {
      name: "the proof bucket's key is unreadable (A1223)",
      expect: 'refused',
      command: opens(expandHome(config.proof.envFile, home)),
    },
    {
      name: "the Linear app's credentials are unreadable (LD4)",
      expect: 'refused',
      command: opens(expandHome(config.linear.envFile, home)),
    },
    {
      name: 'no Linear token in the environment (LD4)',
      expect: 'pass',
      command: `test -z "$(env | grep -E '^LINEAR_' | cut -d= -f1)"`,
    },
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
      output: DEPLOY_REFUSED,
      command: `corepack pnpm --filter @penmoss/relay run deploy --dry-run 2>&1`,
    },
    {
      // Refused before the build; `--dry-run` reaches wrangler only if the guard is gone.
      name: 'a site deploy (task site:deploy) is refused',
      expect: 'refused',
      output: DEPLOY_REFUSED,
      command: `task site:deploy -- --dry-run 2>&1`,
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
    if (exitCode === 0) return { ok: false, detail: 'succeeded, but the sandbox must refuse it' };
    if (check.output !== undefined && !stdout.includes(check.output))
      return { ok: false, detail: `failed (exit ${exitCode}), but not with "${check.output}"` };
    return { ok: true, detail: `refused (exit ${exitCode})` };
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
