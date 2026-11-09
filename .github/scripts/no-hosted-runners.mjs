#!/usr/bin/env node
// No GitHub-hosted runners, ever (A702, F9): every job runs on Ryan's self-hosted Macs. This
// fails when a workflow names a hosted runner (ubuntu-*, windows-*, macos-*), or gives `runs-on`
// as an expression, which could turn into one at run time. Part of `task check`.
//
//   node .github/scripts/no-hosted-runners.mjs [workflow.yml …]   (default: .github/workflows/*)
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOSTED = /^(ubuntu|windows|macos)-[\w.-]+$/i;

/**
 * The problems in one workflow's text: `runs-on` lines that name a hosted runner or use an
 * expression. Reads `runs-on: x`, `runs-on: [a, b]` and a block list under `runs-on:`.
 * @param {string} text
 * @returns {{ line: number; problem: string }[]}
 */
export function problems(text) {
  const lines = text.split('\n');
  /** @type {{ line: number; problem: string }[]} */
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?runs-on:\s*(.*?)\s*(?:#.*)?$/.exec(lines[i] ?? '');
    if (!m) continue;
    let value = m[2] ?? '';
    // A block list or a `group:`/`labels:` map on the following, deeper lines.
    if (value === '' || value === '|' || value === '>') {
      const indent = (m[1] ?? '').length;
      const block = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? '';
        if (l.trim() === '' || l.trim().startsWith('#')) continue;
        if (l.length - l.trimStart().length <= indent) break;
        block.push(
          l
            .trim()
            .replace(/^-\s*/, '')
            .replace(/^labels:\s*/, ''),
        );
      }
      value = block.join(', ');
    }
    if (value.includes('${{')) {
      found.push({
        line: i + 1,
        problem: `runs-on is an expression (${value}); give the self-hosted labels`,
      });
      continue;
    }
    const labels = value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const hosted = labels.filter((l) => HOSTED.test(l));
    if (hosted.length > 0)
      found.push({ line: i + 1, problem: `GitHub-hosted runner ${hosted.join(', ')}` });
    else if (labels.length > 0 && !labels.includes('self-hosted'))
      found.push({ line: i + 1, problem: `runs-on ${labels.join(', ')} isn't self-hosted` });
  }
  return found;
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
    console.error('Every job runs on the self-hosted Macs (A702): never GitHub-hosted runners.');
    process.exitCode = 1;
  }
}
