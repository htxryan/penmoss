/**
 * `task factory:doctor` (F17, #262): starts one slot's sandbox on a throwaway branch and checks
 * that the toolchain works there and that what must stay out does. Each check says what it
 * proves; a failure is loud and names the check. Commands never print a secret: the isolation
 * checks read one byte into /dev/null and print only why the read failed, and the token checks
 * print only an account name.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig, type SlotConfig } from './config.ts';
import type { Exec } from './exec.ts';
import { hostGit } from './git.ts';
import type { SecretKey } from './secrets.ts';
import { withJavaHome } from './sandbox.ts';
import { opencodeConfig } from './agents/opencode.ts';

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

/** One shell word. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** What an unreadable-file check's probe prints when the sandbox, and only it, refused the read. */
export const READ_REFUSED = 'refused by the sandbox';

/**
 * A real read of one byte, sent to /dev/null, that says why it failed: the check passes only when
 * the read was refused (Seatbelt's "Operation not permitted", or "Permission denied"). It was
 * `head -c 0`, which macOS's head rejects ("illegal byte count -- 0", exit 1) before opening the
 * file, so the five checks passed whether or not the sandbox blocked the read (A1258). A missing
 * file, or any other failure, says so and fails the check. Only head's own error reaches stdout,
 * never the file's contents.
 */
export function readProbe(path: string): string {
  return [
    `if why=$(head -c 1 ${quote(path)} 2>&1 >/dev/null); then echo 'read one byte: the sandbox let it through'; exit 0; fi;`,
    'case "$why" in',
    `*'Operation not permitted'*|*'Permission denied'*) echo '${READ_REFUSED}';;`,
    `*'No such file'*) echo "the file doesn't exist, so this proves nothing: $why";;`,
    '*) echo "the read failed for another reason: $why";;',
    'esac; exit 1',
  ].join(' ');
}

/**
 * OpenCode as a run starts it (`agents/opencode.ts`): the factory's config inline, the worktree's
 * own config, autoupdate and Claude Code's files off, and no stdin.
 */
function opencode(config: FactoryConfig, args: string): string {
  const env = [
    `OPENCODE_CONFIG_CONTENT=${quote(opencodeConfig())}`,
    'OPENCODE_DISABLE_PROJECT_CONFIG=1',
    'OPENCODE_DISABLE_AUTOUPDATE=1',
    'OPENCODE_DISABLE_CLAUDE_CODE=1',
  ].join(' ');
  return `${env} ${quote(config.agents.opencode.bin)} ${args} < /dev/null`;
}

/** The model IDs the `opencode` agent's aliases name, its default first. */
function opencodeModels(config: FactoryConfig): string[] {
  const first = config.models[config.agents.opencode.defaultModel]?.model;
  const all = Object.values(config.models)
    .filter((m) => m.agent === 'opencode')
    .map((m) => m.model);
  return [...new Set([...(first ? [first] : []), ...all])];
}

/**
 * `task check` without stopping at the first failure: each `- task:` step of the Taskfile's
 * `check:all`, read from the worktree's own Taskfile, with `test` as `pnpm -r --no-bail`, then
 * one line naming every step that failed.
 */
export const TASK_CHECK_NO_BAIL = [
  "steps=$(sed -n '/^  check:all:/,/^  [^ ]/s/^ *- task: *//p' Taskfile.yml)",
  'test -n "$steps" || { echo "no check:all steps in Taskfile.yml"; exit 2; }',
  'failed=""',
  'for step in $steps; do',
  '  echo "=== task $step"',
  '  if [ "$step" = test ]; then corepack pnpm -r --no-bail --workspace-concurrency=1 test || failed="$failed $step";',
  '  else task "$step" || failed="$failed $step"; fi',
  'done',
  'if [ -n "$failed" ]; then echo "failed:$failed"; exit 1; fi',
  'echo "every step passed"',
].join('\n');

/** A command the factory runs on the host, outside any sandbox. */
export interface HostCommand {
  readonly command: string;
  readonly why: string;
  /** Missing is a warning, not a failure: the factory falls back (terminal-notifier → osascript). */
  readonly optional?: boolean;
}

/** Every external command the host runs: the daemon, the UI, the merge, the proof, planning. */
export function hostCommands(config: FactoryConfig): HostCommand[] {
  return [
    { command: 'git', why: 'reads and pushes runs (publish repo)' },
    { command: 'gh', why: "opens, reads and merges PRs as the factory's app" },
    { command: 'node', why: 'runs the factory' },
    { command: 'corepack', why: "factory:update installs the factory's dependencies" },
    { command: config.agents.claude.bin, why: 'planning sessions, and runs with agent:claude' },
    { command: 'sandbox-exec', why: "every run's Seatbelt sandbox" },
    { command: 'osascript', why: 'notifications' },
    { command: 'caffeinate', why: 'keeps the Mac awake while a run is active' },
    { command: 'ffmpeg', why: "turns the proof's recordings into MP4s" },
    { command: 'tar', why: "the planning session's snapshot of main" },
    {
      command: 'terminal-notifier',
      why: 'notifications that open their card in the Factory UI (osascript is the fallback)',
      optional: true,
    },
    {
      command: config.agents.opencode.bin,
      why: 'runs with agent:opencode',
      optional: true,
    },
  ];
}

/** Where `command` resolves on `path` (an absolute command is checked as it is). */
export function findOnPath(
  command: string,
  path: string,
  executable: (file: string) => boolean = isExecutable,
): string | undefined {
  if (command.includes('/')) return executable(command) ? command : undefined;
  for (const dir of path.split(':').filter(Boolean)) {
    const file = join(dir, command);
    if (executable(file)) return file;
  }
  return undefined;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The host's commands, each looked up on `path`, the PATH the LaunchAgents run with (`agentPath`,
 * code.ts), not the caller's shell: PEN-75's first run failed on a `claude` the doctor had found
 * on Ryan's shell PATH only. A missing optional command is a warning.
 */
export function hostChecks(
  config: FactoryConfig,
  path: string,
  executable?: (file: string) => boolean,
): CheckOutcome[] {
  return hostCommands(config).map((c) => {
    const found = findOnPath(c.command, path, executable);
    const check: Check = {
      name: `the host finds \`${c.command}\` on the LaunchAgent's PATH (${c.why})`,
      command: `command -v ${c.command}`,
      expect: 'pass',
    };
    if (found) return { check, status: 'ok', detail: found, seconds: 0 };
    return {
      check,
      status: c.optional ? 'warned' : 'failed',
      detail: `not on ${path}${c.optional ? ' (optional)' : ''}`,
      seconds: 0,
    };
  });
}

/**
 * A warning when the checks' own code isn't on `base`: they come from this checkout, but the
 * sandbox runs `base`, so a check added on a branch, with the code it tests, can't pass until
 * that code is on `base` (PEN-75's doctor ran a branch's new checks against origin/main).
 */
export async function baseNote(
  exec: Exec,
  repo: string,
  base: string,
): Promise<string | undefined> {
  const contained = await hostGit(exec, repo, ['merge-base', '--is-ancestor', 'HEAD', base]);
  if (contained.code === 0) return undefined;
  const head = await hostGit(exec, repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = head.code === 0 ? head.stdout.trim() : 'HEAD';
  return `Note: the checks come from this checkout (${name}), which ${base} doesn't contain, and the sandbox runs ${base}. A check that tests code only on ${name} fails until that code is on ${base}; run with -- --base ${name} to check the branch itself.`;
}

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
      // The gate runs `task check`, which stops at its first failing step, and `task test` stops
      // at its first failing package: sandbox-only failures then surfaced one per doctor run.
      // This runs every step of the worktree's own `check:all`, and every package's tests.
      name: 'task check, every step and package (no bail)',
      expect: 'pass',
      slow: true,
      output: 'every step passed',
      command: TASK_CHECK_NO_BAIL,
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
      // The prompt has the word in capitals and the check wants it in lower case, so OpenCode
      // echoing the prompt back doesn't pass.
      name: 'OpenCode answers with the Go key and the default model',
      expect: 'pass',
      output: 'factory-ok',
      needs: ['OPENCODE_API_KEY'],
      command: opencode(
        config,
        `run --standalone -m ${quote(opencodeModels(config)[0] ?? '')} 'Reply with exactly this word, in lower case: FACTORY-OK'`,
      ),
    },
    {
      // A model renamed or retired upstream fails here rather than in the first run with it.
      name: "OpenCode Go lists every opencode model in the factory's config",
      expect: 'pass',
      output: 'all listed',
      needs: ['OPENCODE_API_KEY'],
      command: [
        ...opencodeModels(config).map(
          (m) => `${opencode(config, 'models --standalone')} | grep -Fxq ${quote(m)}`,
        ),
        "echo 'all listed'",
      ].join(' && '),
    },
    {
      name: 'wrangler whoami shows the Penmoss account',
      expect: 'pass',
      needs: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
      command: `cd ${relay} && corepack pnpm exec wrangler whoami 2>&1 | grep -i "account" | grep -v -i token`,
    },

    // What stays out.
    {
      // An agent that ignores its deny rules still can't push (F0.4): the sandbox's token is
      // read-only. The helper hands git the token from the environment, never on a command line,
      // and the explicit URL skips whatever remote the worktree has.
      name: "a push with the sandbox's token is refused (A1222)",
      expect: 'refused',
      needs: ['GH_TOKEN'],
      command: `git -c credential.helper= -c 'credential.helper=!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' push --dry-run --no-verify https://github.com/${config.repo}.git HEAD:refs/heads/factory-doctor-push-probe`,
    },
    {
      name: "Ryan's gh login is unreadable",
      expect: 'refused',
      output: READ_REFUSED,
      command: readProbe(`${home}/.config/gh/hosts.yml`),
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
      output: READ_REFUSED,
      command: readProbe(expandHome(config.publisher.envFile, home)),
    },
    {
      name: "the proof bucket's key is unreadable (A1223)",
      expect: 'refused',
      output: READ_REFUSED,
      command: readProbe(expandHome(config.proof.envFile, home)),
    },
    {
      name: "the Linear app's credentials are unreadable (LD4)",
      expect: 'refused',
      output: READ_REFUSED,
      command: readProbe(expandHome(config.linear.envFile, home)),
    },
    {
      name: 'no Linear token in the environment (LD4)',
      expect: 'pass',
      command: `test -z "$(env | grep -E '^LINEAR_' | cut -d= -f1)"`,
    },
    {
      name: 'the login keychain is unreadable',
      expect: 'refused',
      output: READ_REFUSED,
      command: readProbe(`${home}/Library/Keychains/login.keychain-db`),
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
  /** `warned`: something optional is missing; the doctor still passes. */
  readonly status: 'ok' | 'failed' | 'skipped' | 'warned';
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
    if (check.output !== undefined && !stdout.includes(check.output)) {
      const said = stdout.trim().split('\n').at(-1)?.slice(0, 300);
      return {
        ok: false,
        detail: `failed (exit ${exitCode}), but not with "${check.output}"${said ? `: ${said}` : ''}`,
      };
    }
    return { ok: true, detail: `refused (exit ${exitCode})` };
  }
  if (exitCode !== 0) return { ok: false, detail: `exit ${exitCode}` };
  if (check.output !== undefined && !stdout.includes(check.output)) {
    return { ok: false, detail: `output lacks "${check.output}"` };
  }
  return { ok: true, detail: 'passed' };
}

export function report(outcomes: readonly CheckOutcome[]): string {
  const mark = { ok: '✓', failed: '✗', skipped: '–', warned: '!' } as const;
  const lines = outcomes.map(
    (o) =>
      `${mark[o.status]} ${o.check.name}: ${o.detail}${o.status === 'skipped' || o.status === 'warned' ? '' : ` (${o.seconds.toFixed(0)} s)`}`,
  );
  const count = (status: CheckOutcome['status']) =>
    outcomes.filter((o) => o.status === status).length;
  const failed = count('failed');
  const rest = [
    ...(count('skipped') ? [`${count('skipped')} skipped`] : []),
    ...(count('warned') ? [`${count('warned')} warning(s)`] : []),
  ];
  lines.push(
    '',
    failed === 0
      ? `All checks passed${rest.length ? `, ${rest.join(', ')}` : ''}.`
      : `${failed} check(s) FAILED.`,
  );
  return lines.join('\n');
}
