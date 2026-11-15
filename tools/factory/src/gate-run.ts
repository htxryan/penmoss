/**
 * The gate (FD25, F6): the branch rebased onto main in a fresh sandbox, its install and check,
 * the refusals the agent gets back, then the proof the harness records itself (R9) and the
 * validation of a planned change (F19). Proof that passed before on the same diff is carried
 * over (carry.ts, PEN-63).
 */
import type { Platform } from './config.ts';
import type { IssueSpec } from './labels.ts';
import { proofPlatforms, type Scope } from './platforms.ts';
import { criterionLabel, fidelityFeedback, type FidelityRow, settle } from './fidelity.ts';
import {
  type Finding,
  scanWeakenedTests,
  weakenedFeedback,
  workflowChanges,
  workflowFeedback,
} from './gate.ts';
import { validate } from './validate.ts';
import type { AttachedProof } from './proof/body.ts';
import { failedProof, missingProof, type ProofItem } from './proof/manifest.ts';
import { type RebaseOutcome, sandboxNumbering } from './rebase.ts';
import {
  carriedOver,
  diffPrint,
  PROVEN,
  type Proven,
  validationKey,
  type Wanted,
} from './carry.ts';
import type { AgentResult } from './result.ts';
import { excerpt, tail } from './gate-log.ts';
import type { RunSandbox, RunDeps } from './run-deps.ts';
import { withTimeout } from './timeout.ts';
import { whenVmFree } from './vm-wait.ts';

/**
 * The rebased branch's dependencies, before its check (A1251). The rebase can bring main's
 * changed lockfile into a worktree the agent installed earlier; `task lint` then starts with a
 * filtered `pnpm exec`, whose own install pruned every other package's modules, and ESLint
 * failed on 100,000 unresolved types (PEN-70's gate, twice).
 */
export const GATE_INSTALL = 'pnpm install --frozen-lockfile --prefer-offline';

/**
 * One of the gate's long commands, within `gateMinutes` (F2): out of time, what runs in the
 * sandbox is stopped and the run fails with the timeout, instead of holding its heavy-job slot.
 */
export function gateExec(
  gate: RunSandbox,
  command: string,
  minutes: number,
): ReturnType<RunSandbox['exec']> {
  return withTimeout((signal) => gate.exec(command, { signal }), minutes, `\`${command}\``);
}

export function installFeedback(installed: {
  readonly stdout: string;
  readonly stderr: string;
}): string {
  return `\`${GATE_INSTALL}\` failed after the rebase onto \`origin/main\`:\n\n\`\`\`\n${excerpt(installed.stdout + installed.stderr)}\n\`\`\``;
}

export const INSTALL_REASON = 'pnpm install failed after the rebase';

export const conflictReason = (files: readonly string[]) =>
  `rebase conflict${files.length ? `: ${files.join(', ')}` : ''}`;

export const weakenedReason = (findings: readonly Finding[]) =>
  `weakened tests: ${[...new Set(findings.map((f) => f.file))].join(', ')}`;

/**
 * The failed proof tests (`platform: title`, `failedProof`) in one line, by platform:
 * `mac: 1 failed (packaged-cli.spec.ts › reopens)`.
 */
export function proofReason(failing: readonly string[]): string {
  const by = new Map<string, string[]>();
  for (const f of failing) {
    const at = f.indexOf(': ');
    const platform = at < 0 ? 'proof' : f.slice(0, at);
    by.set(platform, [...(by.get(platform) ?? []), at < 0 ? f : f.slice(at + 2)]);
  }
  return [...by]
    .map(
      ([platform, titles]) =>
        `${platform} proof: ${titles.length} failed (${titles[0]}${titles.length > 1 ? ', …' : ''})`,
    )
    .join('; ');
}

/** A gate refusal's reason as one short line: whitespace collapsed, cut at `max` characters. */
export function oneLine(text: string, max = 200): string {
  const line = text.replaceAll(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What the gate runs for a scope (Platform scope in the plan). */
export function gateCommand(scope: Scope): string {
  return scope.kind === 'docs-only' ? 'task lint' : 'task check';
}

export type GateVerdict =
  | {
      readonly ok: true;
      readonly proof: readonly AttachedProof[];
      readonly fidelity?: readonly FidelityRow[];
      /** The number each A-NEW-k on the branch has now (`branchNumbering`). */
      readonly numbering: Readonly<Record<string, string>>;
      /** The platforms whose proof the harness ran and saw pass. */
      readonly proved: readonly Platform[];
      /** The earlier run the proof (and validation) came from, when the gate reused them. */
      readonly carried?: Carried;
    }
  /**
   * `block`: nothing the agent can fix (the test VM stayed unusable): stop, Blocked, now.
   * `mismatches`: the gate and proof passed, and validation found these criteria not met.
   */
  | {
      readonly ok: false;
      readonly feedback: string;
      /** The refusal in one short line, for the ledger and daemon.log (`gate-failed`). */
      readonly reason: string;
      readonly block?: string;
      readonly mismatches?: readonly string[];
    };

/** Proof carried over from an earlier run: which, and whether its validation came with it. */
export interface Carried {
  readonly run: string;
  readonly validated: boolean;
}

/**
 * The gate, in a fresh sandbox on the branch (FD25), then the proof the harness records itself.
 * `carry`: keep what passed (`proven.json`, carry.ts), and reuse an earlier run's proof and
 * validation when the branch's own diff outside docs/decisions.md is the one they passed on.
 */
export async function gateAndProve(
  deps: RunDeps,
  branch: string,
  scope: Scope,
  spec: IssueSpec,
  result: AgentResult,
  validation?: { readonly plan: string; readonly final: boolean; readonly images?: string },
  options: { readonly carry?: boolean } = {},
): Promise<GateVerdict> {
  const needed = proofPlatforms(scope, spec.platforms);
  // R9: an in-scope platform needs a named proof spec before anything runs.
  const unnamed = needed.filter((p) => !result.platforms[p]?.proofSpecs.length);
  if (unnamed.length > 0) {
    return {
      ok: false,
      reason: `no proof spec named for ${unnamed.join(', ')}`,
      feedback: `\`result.json\` names no proof spec for ${unnamed.join(', ')}, which the change affects. Add a committed test that shows the change and list it under \`platforms.<name>.proofSpecs\`.`,
    };
  }
  await deps.step('the gate');
  await deps.fetchMain();
  const gate = await deps.openSandbox(branch);
  try {
    const clean = await gate.exec('git status --porcelain --untracked-files=no');
    if (clean.stdout.trim() !== '')
      return {
        ok: false,
        reason: 'uncommitted changes',
        feedback: 'the branch has uncommitted changes to tracked files.',
      };
    // Up to date with main before anything is checked (F6). The harness resolves new decision
    // rows on both sides; any other conflict is the agent's to resolve.
    const rebased = await deps.rebase(gate);
    if (rebased.kind === 'conflict')
      return {
        ok: false,
        reason: conflictReason(rebased.files),
        feedback: conflictFeedback(branch, rebased),
      };
    noteRebase(deps, rebased);
    const numbered = await deps.numberDecisions(gate, branch);
    if (Object.keys(numbered).length > 0) deps.log('decisions-numbered', numbered);
    const installed = await gateExec(gate, GATE_INSTALL, deps.config.timeouts.gateMinutes);
    if (installed.exitCode !== 0)
      return { ok: false, reason: INSTALL_REASON, feedback: installFeedback(installed) };
    const patch = (await gate.exec('git diff origin/main...HEAD')).stdout;
    const weak = scanWeakenedTests(patch);
    if (weak.length > 0)
      return { ok: false, reason: weakenedReason(weak), feedback: weakenedFeedback(weak) };
    // GitHub refuses the factory's push of a workflow change: refuse it here, before the push.
    const workflows = workflowChanges(patch);
    if (workflows.length > 0)
      return {
        ok: false,
        reason: `workflow change: ${workflows.join(', ')}`,
        feedback: workflowFeedback(workflows),
      };
    const command = gateCommand(scope);
    const checked = await deps.heavy(`factory gate ${branch}`, () =>
      gateExec(gate, command, deps.config.timeouts.gateMinutes),
    );
    if (checked.exitCode !== 0) {
      deps.keep?.('gate.log', checked.stdout + checked.stderr);
      return {
        ok: false,
        reason: `${command} failed`,
        feedback: `\`${command}\` failed:\n\n\`\`\`\n${excerpt(checked.stdout + checked.stderr)}\n\`\`\``,
      };
    }
    deps.log('gate-passed', { command });
    // F19: a planned change that users see is walked on each app it affects and reviewed
    // against the plan (PEN-94).
    const validating = validation && scope.platforms.length > 0 ? validation : undefined;
    const wanted =
      options.carry && (needed.length > 0 || validating)
        ? await wantedNow(gate, needed, result, scope, validating)
        : undefined;
    // Proved and validated before on exactly these changes (a recovered run, rebased onto a main
    // that moved a decision row): the earlier run's proof and verdict stand.
    const earlier = wanted && carriedOver(deps.provenBefore?.(wanted.diff), wanted);
    if (wanted && earlier) {
      deps.log('proof-reused', {
        from: earlier.run,
        files: earlier.proof.length,
        diff: wanted.diff,
      });
      const rows = wanted.validation ? earlier.validation?.rows : undefined;
      if (rows)
        deps.log('validation-reused', {
          from: earlier.run,
          ...verdictCounts(rows),
        });
      return {
        ok: true,
        proof: earlier.proof,
        ...(rows ? { fidelity: settle(rows) } : {}),
        numbering: await sandboxNumbering(gate),
        proved: needed,
        carried: { run: earlier.run, validated: Boolean(rows) },
      };
    }
    const proven = (proof: readonly AttachedProof[], rows?: readonly FidelityRow[]) => {
      if (!wanted) return;
      const record: Proven = {
        run: deps.runId,
        diff: wanted.diff,
        specs: wanted.specs,
        proof,
        ...(rows && wanted.validation ? { validation: { key: wanted.validation.key, rows } } : {}),
      };
      deps.keep?.(PROVEN, `${JSON.stringify(record, null, 2)}\n`);
    };
    const items: ProofItem[] = [];
    for (const platform of needed) {
      const specs = result.platforms[platform]?.proofSpecs ?? [];
      if (platform === 'mac') {
        const mac = await recordMacProof(deps, gate, branch, specs);
        if (!mac.ok)
          return {
            ok: false,
            reason: `mac proof: ${mac.feedback}`,
            feedback: mac.feedback,
            block: 'mac-vm',
          };
        items.push(...mac.items);
        continue;
      }
      items.push(
        ...(await deps.heavy(`factory proof ${platform} ${branch}`, () =>
          withTimeout(
            (signal) => deps.recordProof(gate, platform, specs, signal),
            deps.config.timeouts.proofMinutes,
            `recording ${platform} proof`,
          ),
        )),
      );
    }
    const missing = missingProof(items, needed);
    if (missing.length > 0) {
      return {
        ok: false,
        reason: missing.map((p) => `${p} proof: no passing recording`).join('; '),
        feedback: `the proof specs for ${missing.join(', ')} didn't pass when the harness ran them with recording on. ${LAST_PROOF_NOTE}${proofOutput(deps, missing)}`,
      };
    }
    const failing = failedProof(items, needed);
    if (failing.length > 0) {
      const platforms = needed.filter((p) => failing.some((f) => f.startsWith(`${p}: `)));
      return {
        ok: false,
        reason: proofReason(failing),
        feedback: `these tests in your proof specs failed when the harness ran them with recording on:\n\n${failing.map((f) => `- ${f}`).join('\n')}\n\nEvery test in a proof spec has to pass: fix the code or the test. ${LAST_PROOF_NOTE}${proofOutput(deps, platforms)}`,
      };
    }
    const prepared = await deps.prepareProof(items);
    if (!prepared.ok)
      return {
        ok: false,
        reason: `preparing the proof failed: ${prepared.error}`,
        feedback: prepared.error,
      };
    deps.log('proof-recorded', {
      files: prepared.proof.length,
      ...(wanted ? { diff: wanted.diff } : {}),
    });
    if (validating) {
      const v = await validate(deps, gate, branch, {
        plan: validating.plan,
        builder: result.risks,
        images: validating.images ?? '',
        platforms: scope.platforms,
      });
      if (!v.ok)
        return {
          ok: false,
          reason: `validation couldn't finish: ${v.error}`,
          feedback: `Validation couldn't finish: ${v.error}`,
        };
      const mismatches = v.rows.filter((r) => r.verdict === 'mismatch');
      if (mismatches.length > 0 && !validating.final)
        return {
          ok: false,
          reason: `validation: ${mismatches.map((r) => criterionLabel(r.criterion)).join(', ')} not met`,
          feedback: fidelityFeedback(mismatches),
          mismatches: mismatches.map((r) => criterionLabel(r.criterion)),
        };
      proven(prepared.proof, v.rows);
      return {
        ok: true,
        proof: prepared.proof,
        fidelity: settle(v.rows),
        numbering: await sandboxNumbering(gate),
        proved: needed,
      };
    }
    proven(prepared.proof);
    return {
      ok: true,
      proof: prepared.proof,
      numbering: await sandboxNumbering(gate),
      proved: needed,
    };
  } finally {
    await gate.close();
  }
}

/** What the gate would prove and validate now, for carriedOver; undefined without a diff print. */
async function wantedNow(
  gate: RunSandbox,
  needed: readonly Platform[],
  result: AgentResult,
  scope: Scope,
  validating: { readonly plan: string; readonly final: boolean } | undefined,
): Promise<Wanted | undefined> {
  const diff = await diffPrint(gate);
  if (!diff) return undefined;
  return {
    diff,
    specs: Object.fromEntries(needed.map((p) => [p, result.platforms[p]?.proofSpecs ?? []])),
    ...(validating
      ? {
          validation: {
            key: validationKey({
              plan: validating.plan,
              builder: result.risks,
              platforms: scope.platforms,
            }),
            final: validating.final,
          },
        }
      : {}),
  };
}

function verdictCounts(rows: readonly FidelityRow[]): Record<string, number> {
  return {
    match: rows.filter((r) => r.verdict === 'match').length,
    mismatch: rows.filter((r) => r.verdict === 'mismatch').length,
    deviation: rows.filter((r) => r.verdict === 'deviation').length,
  };
}

/** The Mac proof, once the test VM can take it (whenVmFree). */
export async function recordMacProof(
  deps: RunDeps,
  gate: RunSandbox,
  branch: string,
  specs: readonly string[],
): Promise<{ ok: true; items: ProofItem[] } | { ok: false; feedback: string }> {
  const ran = await whenVmFree(
    deps,
    gate,
    'the Mac proof',
    `factory proof mac ${branch}`,
    (signal) => deps.recordProof(gate, 'mac', specs, signal),
  );
  if (ran.ok) return { ok: true, items: ran.value };
  const why = ran.why.replace(/^the Mac proof/, 'The Mac proof');
  return {
    ok: false,
    feedback: `${why} Fix the VM (docs/ci.md §8), then clear **${deps.config.blockedField}**.`,
  };
}

/**
 * What the agent's next sandbox has from the proof (`stageLastProof` in host-proof.ts, and
 * proof/evidence.ts for what a failing test leaves), named as the files are.
 */
export const LAST_PROOF_NOTE =
  "The harness's files from this proof are in `.factory/last-proof/`: each test's last screenshot (`<platform>-<n>-screenshot.png`, or `.jpg` when it is the Mac window's last screencast frame), and for each failing test `<platform>-failures.md`, which gives its error and lists its files there: Playwright's `<platform>-<n>-error-context.md`, its text attachments and logs (`<platform>-<n>-<attachment>.txt` or `.log`, each cut to its last 200 KB; on Android its instrumentation output and logcat) and its PNG attachments. Read them before you change anything, to see where and why the spec stopped.";

/** What each missing platform's proof printed, for the agent: the harness's run, not its own. */
function proofOutput(deps: RunDeps, platforms: readonly Platform[]): string {
  return platforms
    .map((p) => [p, deps.proofLog?.(p)] as const)
    .filter((e): e is readonly [Platform, string] => Boolean(e[1]?.trim()))
    .map(([p, log]) => `\n\nThe ${p} proof's output:\n\n\`\`\`\n${excerpt(log)}\n\`\`\``)
    .join('');
}

export type Rebased = Extract<RebaseOutcome, { kind: 'rebased' }>;

export function conflictFeedback(
  branch: string,
  conflict: Extract<RebaseOutcome, { kind: 'conflict' }>,
) {
  const files = conflict.files.map((f) => `\`${f}\``).join(', ');
  return `\`git rebase origin/main\` stopped on conflicts${files ? ` in ${files}` : ''}:\n\n\`\`\`\n${tail(conflict.output)}\n\`\`\`\n\nRebase \`${branch}\` onto \`origin/main\` yourself, resolve them, and commit.`;
}

export function noteRebase(deps: RunDeps, rebased: Rebased): void {
  if (rebased.resolved.length > 0 || Object.keys(rebased.renumbered).length > 0)
    deps.log('rebased', { resolved: rebased.resolved, renumbered: rebased.renumbered });
}
