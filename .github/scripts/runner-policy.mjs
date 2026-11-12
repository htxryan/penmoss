#!/usr/bin/env node
// Where CI's jobs may run (A1235 and A1348, which supersede A702 and amend A1218). The
// repository is public, so GitHub's standard hosted Linux and Mac runners cost nothing; its larger
// runners are billed even for a public repository, and Ryan's self-hosted Macs must never run a
// fork's code. This fails on:
//
// - a `runs-on` that is neither a standard hosted label (ubuntu-latest, ubuntu-24.04,
//   macos-latest) nor self-hosted Mac labels: a larger runner (`ubuntu-latest-4-cores`,
//   `macos-latest-xlarge`, any custom name), a runner group, Windows or other hosted images, or
//   an unknown self-hosted label;
// - a `runs-on` given as an expression, which could turn into any of those at run time;
// - a self-hosted job, in a workflow that runs on pull requests, whose `if:` doesn't start with
//   the fork guard (P10, A1183), so a fork's pull request could reach a Mac.
//
// Part of `task ci:lint` (and so of `task check`).
//
//   node .github/scripts/runner-policy.mjs [workflow.yml …]   (default: .github/workflows/*)
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FORK_GUARD, parseWorkflow } from './workflow-guard.mjs';

/** GitHub's standard hosted runners, free for a public repository (macos-latest: Apple Silicon). */
export const STANDARD_HOSTED = ['ubuntu-latest', 'ubuntu-24.04', 'macos-latest'];

/** The labels of Ryan's self-hosted Macs (docs/ci.md §2, .github/actionlint.yaml). */
export const MAC_LABELS = [
  'self-hosted',
  'macOS',
  'ARM64',
  'penmoss-mac',
  'penmoss-mac-ports',
  'penmoss-mac-general',
  'penmoss-mac-vm',
];

/** GitHub's own hosted images, of any size. Anything else not self-hosted is a larger runner. */
const HOSTED_IMAGE = /^(ubuntu|windows|macos)-[\w.-]+$/i;

/**
 * Every `runs-on` in one workflow's text, as its line and value: `runs-on: x`, `runs-on: [a, b]`,
 * and a block list or a `group:`/`labels:` map under `runs-on:`.
 * @param {string} text
 * @returns {{ line: number; value: string; group: boolean }[]}
 */
export function runsOnValues(text) {
  const lines = text.split('\n');
  /** @type {{ line: number; value: string; group: boolean }[]} */
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?runs-on:\s*(.*?)\s*(?:#.*)?$/.exec(lines[i] ?? '');
    if (!m) continue;
    let value = m[2] ?? '';
    let group = false;
    if (value === '' || value === '|' || value === '>') {
      const indent = (m[1] ?? '').length;
      const block = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? '';
        if (l.trim() === '' || l.trim().startsWith('#')) continue;
        if (l.length - l.trimStart().length <= indent) break;
        const item = l.trim().replace(/\s+#.*$/, '');
        if (/^group:/.test(item)) group = true;
        block.push(item.replace(/^-\s*/, '').replace(/^(labels|group):\s*/, ''));
      }
      value = block.join(', ');
    }
    if (/^\{.*\bgroup\s*:/.test(value)) group = true;
    found.push({ line: i + 1, value, group });
  }
  return found;
}

/** @param {string} value */
function labelsOf(value) {
  return value
    .replace(/^[[{]|[\]}]$/g, '')
    .split(',')
    .map((s) =>
      s
        .trim()
        .replace(/^(labels|group):\s*/, '')
        .replace(/^['"]|['"]$/g, ''),
    )
    .filter(Boolean);
}

/**
 * What is wrong with one `runs-on` value, or null.
 * @param {{ value: string; group: boolean }} runsOn
 * @returns {string | null}
 */
export function runsOnProblem({ value, group }) {
  if (value.includes('${{')) {
    return `runs-on is an expression (${value}); name ${STANDARD_HOSTED.join(' or ')}, or the self-hosted Mac labels`;
  }
  if (group) return `runs-on names a runner group (${value}); larger runners are billed`;
  const labels = labelsOf(value);
  if (labels.length === 0) return 'runs-on is empty';
  if (labels.includes('self-hosted')) {
    const unknown = labels.filter((l) => !MAC_LABELS.includes(l));
    if (unknown.length > 0) {
      return `self-hosted label ${unknown.join(', ')} isn't one of Ryan's Macs' (${MAC_LABELS.join(', ')})`;
    }
    if (!labels.some((l) => l.startsWith('penmoss-mac'))) {
      return `runs-on ${labels.join(', ')} names no penmoss-mac label, so any self-hosted runner could take it`;
    }
    return null;
  }
  if (labels.length === 1 && STANDARD_HOSTED.includes(labels[0] ?? '')) return null;
  const label = labels.join(', ');
  if (labels.length === 1 && HOSTED_IMAGE.test(label)) {
    return `${label} isn't a standard hosted runner this repository uses; use ${STANDARD_HOSTED.join(' or ')}`;
  }
  return `runs-on ${label} is neither ${STANDARD_HOSTED.join(' nor ')} nor self-hosted (a larger runner is billed)`;
}

/**
 * Self-hosted jobs that a fork's pull request could reach: in a workflow that runs on
 * `pull_request`, every job on a self-hosted runner starts its `if:` with the fork guard.
 * @param {string} text
 * @returns {{ job: string; problem: string }[]}
 */
export function forkProblems(text) {
  const workflow = parseWorkflow(text);
  if (!workflow.triggers.some((t) => t === 'pull_request' || t === 'pull_request_target')) {
    return [];
  }
  /** @type {{ job: string; problem: string }[]} */
  const found = [];
  for (const job of workflow.jobs) {
    // parseWorkflow folds a block list into one line, separated by spaces.
    if (!job.runsOn.split(/[\s,[\]'"]+/).includes('self-hosted')) continue;
    const condition = (job.if ?? '').replace(/\s+/g, ' ');
    if (condition === 'false') continue;
    if (condition !== FORK_GUARD && !condition.startsWith(`(${FORK_GUARD}) && `)) {
      found.push({
        job: job.name,
        problem: `job ${job.name} runs on a self-hosted Mac, which a fork's pull request could reach: its if: must start with (${FORK_GUARD}) && …`,
      });
    }
  }
  return found;
}

/**
 * Every problem in one workflow's text.
 * @param {string} text
 * @returns {{ line: number; problem: string }[]}
 */
export function problems(text) {
  /** @type {{ line: number; problem: string }[]} */
  const found = [];
  for (const runsOn of runsOnValues(text)) {
    const problem = runsOnProblem(runsOn);
    if (problem) found.push({ line: runsOn.line, problem });
  }
  const lines = text.split('\n');
  for (const { job, problem } of forkProblems(text)) {
    const line = lines.findIndex((l) => l === `  ${job}:`) + 1;
    found.push({ line, problem });
  }
  return found.sort((a, b) => a.line - b.line);
}

// Run as a script, not imported. As URLs, so a checkout whose path has a space or a symlink in
// it still runs the check (the factory's worktrees are under "Application Support").
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const dir = '.github/workflows';
  const files =
    process.argv.length > 2
      ? process.argv.slice(2)
      : readdirSync(dir)
          .filter((f) => /\.ya?ml$/.test(f))
          .map((f) => join(dir, f));
  let bad = 0;
  for (const file of files) {
    for (const p of problems(readFileSync(file, 'utf8'))) {
      console.error(`${file}:${p.line}: ${p.problem}`);
      bad++;
    }
  }
  if (bad > 0) {
    console.error(
      `Jobs run on ${STANDARD_HOSTED.join(' or ')}, or on Ryan's self-hosted Macs behind the fork guard (A1235, docs/ci.md §1).`,
    );
    process.exitCode = 1;
  }
}
