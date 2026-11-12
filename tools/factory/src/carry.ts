/**
 * Proof and validation carried over from an earlier run of the same card (PEN-63, 11 Nov 2026).
 * PEN-63's recovered run rebased onto main because another PR's decision row landed beside its
 * own, then recorded web, Mac and Android proof and ran the whole validation again, about 19
 * minutes, though the branch's own changes outside `docs/decisions.md` were byte for byte what
 * had been proved and validated.
 *
 * So when proof and validation pass, the gate keeps what they produced in the run folder
 * (`proven.json`), with a print of the branch's own diff. A later run whose print is the same
 * reuses that proof and verdict instead of recording them again. The print is the branch's diff
 * against its merge base with main, not the tree, so main's changes that a rebase brings in
 * don't count; they're CI's to check on the PR. Anything missing, unreadable or different means
 * the full proof and validation, as before.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from './config.ts';
import type { FidelityRow, Verdict } from './fidelity.ts';
import type { AttachedProof } from './proof/body.ts';
import type { RunSandbox } from './run.ts';

/** The file in the run folder that holds what passed. */
export const PROVEN = 'proven.json';

/** The one file whose changes don't count: decision rows main's rebase moved or renumbered. */
const LEFT_OUT = 'docs/decisions.md';

/**
 * Every path the branch changes against its merge base with `origin/main`, except
 * `docs/decisions.md`, with its mode and the full blob ids of both sides. Two branches print the
 * same only when each such file is byte for byte the same before and after, whatever main did to
 * files the branch doesn't touch.
 */
export const DIFF_PRINT = `git diff --raw --no-abbrev --no-renames --no-ext-diff --no-textconv origin/main...HEAD -- . ':(exclude)${LEFT_OUT}'`;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The print of the branch's own diff in a gate sandbox, rebased onto main: a sha256 of
 * `DIFF_PRINT`'s output. Undefined when git fails or the branch changes nothing but
 * `docs/decisions.md`: then nothing is carried over.
 */
export async function diffPrint(sandbox: RunSandbox): Promise<string | undefined> {
  const raw = await sandbox.exec(DIFF_PRINT).catch(() => undefined);
  if (!raw || raw.exitCode !== 0) return undefined;
  const lines = raw.stdout
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
  if (
    lines.length === 0 ||
    !lines.every((l) => /^:\d{6} \d{6} [0-9a-f]{40,64} [0-9a-f]{40,64} [A-Z]\d*\t/.test(l))
  )
    return undefined;
  return sha256(lines.join('\n'));
}

/** What a validation was asked: the plan, what the builder said it couldn't do, the apps walked. */
export function validationKey(input: {
  readonly plan: string;
  readonly builder: readonly string[];
  readonly platforms: readonly Platform[];
}): string {
  return sha256(
    JSON.stringify({
      plan: input.plan,
      builder: input.builder,
      platforms: [...input.platforms].sort(),
    }),
  );
}

/** What a run's gate kept once its proof (and validation, when one ran) passed. */
export interface Proven {
  readonly run: string;
  /** `diffPrint` at the time. */
  readonly diff: string;
  /** The platforms proved, and each one's proof specs. */
  readonly specs: Readonly<Partial<Record<Platform, readonly string[]>>>;
  /** The proof as the PR body shows it: file names in `runs/<run>/proof/`. */
  readonly proof: readonly AttachedProof[];
  /** The reviewer's rows as it gave them (not settled), and what it was asked. */
  readonly validation?: { readonly key: string; readonly rows: readonly FidelityRow[] };
}

const PLATFORMS: readonly Platform[] = ['web', 'mac', 'android'];
const VERDICTS: readonly Verdict[] = ['match', 'mismatch', 'deviation'];
/** A plain file name in the proof folder: no folders, no way out of it. */
const FILE = /^[\w.-]+\.(png|mp4|jpg|webp|gif)$/;
const RUN = /^[\w-]+$/;

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');
const optionalFile = (v: unknown) => v === undefined || (typeof v === 'string' && FILE.test(v));

/** `proven.json`, checked field by field; undefined when anything about it is off. */
export function parseProven(text: string): Proven | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p['run'] !== 'string' || !RUN.test(p['run'])) return undefined;
  if (typeof p['diff'] !== 'string' || !/^[0-9a-f]{64}$/.test(p['diff'])) return undefined;
  const specs = p['specs'];
  if (!specs || typeof specs !== 'object' || Array.isArray(specs)) return undefined;
  for (const [k, v] of Object.entries(specs))
    if (!PLATFORMS.includes(k as Platform) || !isStrings(v)) return undefined;
  const proof = p['proof'];
  if (!Array.isArray(proof)) return undefined;
  for (const item of proof as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object' || typeof item['label'] !== 'string') return undefined;
    if (item['phase'] !== 'before' && item['phase'] !== 'after') return undefined;
    if (item['source'] !== 'harness' && item['source'] !== 'agent') return undefined;
    if (!optionalFile(item['image']) || !optionalFile(item['video'])) return undefined;
  }
  const validation = p['validation'];
  if (validation !== undefined) {
    if (!validation || typeof validation !== 'object') return undefined;
    const v = validation as Record<string, unknown>;
    if (typeof v['key'] !== 'string' || !Array.isArray(v['rows']) || v['rows'].length === 0)
      return undefined;
    for (const row of v['rows'] as Record<string, unknown>[]) {
      if (!row || typeof row !== 'object') return undefined;
      if (typeof row['criterion'] !== 'string' || typeof row['note'] !== 'string') return undefined;
      if (!VERDICTS.includes(row['verdict'] as Verdict)) return undefined;
      if (!optionalFile(row['mockup']) || !optionalFile(row['screenshot'])) return undefined;
      if (row['platform'] !== undefined && !PLATFORMS.includes(row['platform'] as Platform))
        return undefined;
    }
  }
  return raw as Proven;
}

/** Every file a record's proof and fidelity rows name, which must still be in its run folder. */
export function provenFiles(proven: Proven): string[] {
  return [
    ...proven.proof.flatMap((p) => [p.image, p.video]),
    ...(proven.validation?.rows ?? []).flatMap((r) => [r.mockup, r.screenshot]),
  ].filter((f): f is string => Boolean(f));
}

/**
 * The card's earlier runs whose proof was recorded with this print (`proof-recorded`'s `diff`),
 * newest first. Only candidates: a run's `proven.json` says whether its validation passed too.
 */
export function provenRuns(ledger: string, issue: number, diff: string, except?: string): string[] {
  const runs: string[] = [];
  for (const line of ledger.split('\n')) {
    if (!line.trim()) continue;
    let e: { event?: string; issue?: number; run?: string; diff?: string };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue; // A torn last line from a crash.
    }
    if (e.event !== 'proof-recorded' || e.diff !== diff || !e.run || !RUN.test(e.run)) continue;
    if ((e.issue ?? Number(e.run.split('-')[0])) !== issue || e.run === except) continue;
    if (!runs.includes(e.run)) runs.push(e.run);
  }
  return runs.reverse();
}

/** What this gate would prove and validate now. */
export interface Wanted {
  readonly diff: string;
  readonly specs: Readonly<Partial<Record<Platform, readonly string[]>>>;
  /** Set when validation is due: what it would be asked, and whether this is the last round. */
  readonly validation?: { readonly key: string; readonly final: boolean };
}

/**
 * Whether an earlier run's record stands in for this gate's proof and validation: the same
 * print, the same platforms with the same proof specs, and, when validation is due, a verdict
 * given on the same plan with nothing left to fix (or, on the last round, whatever it said, as a
 * fresh last-round validation would be taken). Any difference: undefined, and the gate proves.
 */
export function carriedOver(proven: Proven | undefined, wanted: Wanted): Proven | undefined {
  if (!proven || proven.diff !== wanted.diff) return undefined;
  const same = (a: readonly string[] = [], b: readonly string[] = []) =>
    a.length === b.length && a.every((s, i) => s === b[i]);
  const platforms = PLATFORMS.filter((p) => wanted.specs[p] !== undefined);
  const had = PLATFORMS.filter((p) => proven.specs[p] !== undefined);
  if (!same(platforms, had)) return undefined;
  if (!platforms.every((p) => same(wanted.specs[p], proven.specs[p]))) return undefined;
  if (platforms.length > 0 && proven.proof.length === 0) return undefined;
  if (wanted.validation) {
    const v = proven.validation;
    if (!v || v.key !== wanted.validation.key) return undefined;
    if (!wanted.validation.final && v.rows.some((r) => r.verdict === 'mismatch')) return undefined;
  }
  return proven;
}

/**
 * The card's latest earlier run, from the ledger in the state folder, whose `proven.json` has
 * this print and whose proof folder still has every file it names (the janitor removes old run
 * folders). Undefined when there is none: the gate proves and validates as before.
 */
export function findProven(
  state: string,
  issue: number,
  diff: string,
  except?: string,
): Proven | undefined {
  const ledger = join(state, 'runs.jsonl');
  if (!existsSync(ledger)) return undefined;
  for (const run of provenRuns(readFileSync(ledger, 'utf8'), issue, diff, except)) {
    const dir = join(state, 'runs', run);
    const file = join(dir, PROVEN);
    if (!existsSync(file) || !lstatSync(file).isFile()) continue;
    const proven = parseProven(readFileSync(file, 'utf8'));
    if (!proven || proven.run !== run || proven.diff !== diff) continue;
    const there = (name: string) => {
      const at = join(dir, 'proof', name);
      return existsSync(at) && lstatSync(at).isFile();
    };
    if (provenFiles(proven).every(there)) return proven;
  }
  return undefined;
}
