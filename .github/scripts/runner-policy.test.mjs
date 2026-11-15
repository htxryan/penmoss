// Where CI's jobs may run (A1235) and the fork guard (P10, A1183): .github/scripts/
// runner-policy.mjs against fixture workflows and the real ones. Part of `task ci:lint`. The fork
// guard's cases came from workflow-guard.test.mjs (A1481).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { problems } from './runner-policy.mjs';
import { FORK_GUARD, parseWorkflow } from './workflow-yaml.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const GUARD =
  "(github.event_name != 'pull_request' ||\n      github.event.pull_request.head.repo.full_name == github.repository)";

/** A workflow with the given jobs, on pull requests and pushes unless `on` says otherwise. */
const workflow = (/** @type {string} */ jobs, on = 'on:\n  pull_request:\n  push:\n') =>
  `name: Fixture\n\n${on}\npermissions:\n  contents: read\n\njobs:\n${jobs}`;

/** @param {string} text */
const messages = (text) => problems(text).map((p) => p.problem);

test('passes the real workflows', () => {
  const dir = join(here, '..', 'workflows');
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    assert.deepEqual(problems(readFileSync(join(dir, file), 'utf8')), [], file);
  }
});

test('passes the standard hosted runners, in every form', () => {
  for (const runsOn of [
    'ubuntu-latest',
    'ubuntu-24.04',
    'macos-latest',
    "'ubuntu-latest'",
    '[ubuntu-latest]',
    '\n      - ubuntu-24.04',
  ]) {
    assert.deepEqual(messages(workflow(`  a:\n    runs-on: ${runsOn}\n    steps: []\n`)), []);
  }
});

test('passes guarded self-hosted Mac jobs, in every form', () => {
  const jobs = [
    `  a:\n    if: ${FORK_GUARD}\n    runs-on: [self-hosted, macOS, ARM64, penmoss-mac]\n`,
    `  b:\n    if: >-\n      ${GUARD} &&\n      needs.pick.outputs.web == 'true'\n    runs-on: ['self-hosted', "penmoss-mac-general"]\n`,
    `  c:\n    if: >-\n      ${GUARD} &&\n      true\n    runs-on:\n      - self-hosted\n      - penmoss-mac-ports\n    steps: []\n`,
  ].join('\n');
  assert.deepEqual(messages(workflow(jobs)), []);
});

test('fails larger runners, runner groups and other hosted images, even in a job that is off', () => {
  const cases = {
    'ubuntu-latest-4-cores': /ubuntu-latest-4-cores isn't a standard hosted runner/,
    'ubuntu-24.04-arm': /ubuntu-24\.04-arm isn't a standard hosted runner/,
    'ubuntu-22.04': /ubuntu-22\.04 isn't a standard hosted runner/,
    'macos-15': /macos-15 isn't a standard hosted runner/,
    'macos-latest-xlarge': /macos-latest-xlarge isn't a standard hosted runner/,
    '[windows-2022]': /windows-2022 isn't a standard hosted runner/,
    'penmoss-large': /neither ubuntu-latest nor ubuntu-24\.04 nor macos-latest nor self-hosted/,
    '[ubuntu-latest, gpu]':
      /neither ubuntu-latest nor ubuntu-24\.04 nor macos-latest nor self-hosted/,
    '\n      group: big-runners': /runner group/,
    '\n      group: big-runners\n      labels: [ubuntu-latest]': /runner group/,
    '{ group: big-runners }': /runner group/,
  };
  for (const [runsOn, expected] of Object.entries(cases)) {
    const found = messages(workflow(`  a:\n    if: false\n    runs-on: ${runsOn}\n`));
    assert.equal(found.length, 1, `${runsOn}: ${found.join('; ')}`);
    assert.match(found[0] ?? '', expected, runsOn);
  }
});

test('fails an expression, which could pick any runner at run time', () => {
  // The fork guard refuses it as well, as it could name a Mac (below).
  assert.match(
    messages(workflow('  a:\n    runs-on: ${{ fromJSON(needs.pick.outputs.mac) }}\n')).join('\n'),
    /expression/,
  );
  assert.match(
    messages(workflow('  a:\n    runs-on: ${{ matrix.os }}\n')).join('\n'),
    /expression/,
  );
});

test("fails a self-hosted label that isn't one of the Macs', or names no Mac", () => {
  const off = (/** @type {string} */ runsOn) =>
    workflow(`  a:\n    if: false\n    runs-on: ${runsOn}\n`);
  assert.match(messages(off('[self-hosted, linux, big]'))[0] ?? '', /label linux, big isn't one/);
  assert.match(messages(off('[self-hosted, macOS]'))[0] ?? '', /names no penmoss-mac label/);
  assert.match(messages(off('[penmoss-mac]'))[0] ?? '', /neither ubuntu-latest/);
});

test("fails a self-hosted job that a fork's pull request could reach", () => {
  const unguarded = [
    '  a:\n    runs-on: [self-hosted, macOS, ARM64, penmoss-mac]\n',
    "  b:\n    if: github.event_name == 'push'\n    runs-on: [self-hosted, penmoss-mac]\n",
    `  c:\n    if: >-\n      ${GUARD} ||\n      true\n    runs-on: [self-hosted, penmoss-mac]\n`,
    '  d:\n    if: always()\n    runs-on:\n      - self-hosted\n      - penmoss-mac\n',
  ];
  for (const job of unguarded) {
    const found = problems(workflow(job));
    assert.equal(found.length, 1, job);
    assert.match(found[0]?.problem ?? '', /a fork's pull request could reach/);
    assert.equal(found[0]?.line, 11, 'points at the job');
  }
});

test('needs no fork guard on a hosted job, an off job, or a workflow without pull requests', () => {
  assert.deepEqual(messages(workflow('  a:\n    runs-on: ubuntu-latest\n')), []);
  assert.deepEqual(
    messages(workflow('  a:\n    if: false\n    runs-on: [self-hosted, penmoss-mac]\n')),
    [],
  );
  for (const on of ["on:\n  push:\n    tags: ['v*']\n", 'on:\n  issues:\n', 'on: [push]\n']) {
    assert.deepEqual(
      messages(workflow('  a:\n    runs-on: [self-hosted, penmoss-mac-general]\n', on)),
      [],
      on,
    );
  }
  assert.equal(
    messages(
      workflow('  a:\n    runs-on: [self-hosted, penmoss-mac]\n', 'on: [push, pull_request]\n'),
    ).length,
    1,
  );
});

test('the command line runs the check from a checkout whose path has a space', () => {
  // The factory's worktrees are under "~/Library/Application Support" (A1231).
  const dir = mkdtempSync(join(tmpdir(), 'runner policy '));
  try {
    for (const f of ['runner-policy.mjs', 'workflow-yaml.mjs'])
      copyFileSync(join(here, f), join(dir, f));
    const file = join(dir, 'ci.yml');
    writeFileSync(file, workflow('  a:\n    runs-on: ubuntu-latest-8-cores\n'));
    const r = spawnSync('node', [join(dir, 'runner-policy.mjs'), file], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /ci\.yml:12: ubuntu-latest-8-cores isn't a standard hosted runner/);
    writeFileSync(file, workflow('  a:\n    runs-on: ubuntu-latest\n'));
    const ok = spawnSync('node', [join(dir, 'runner-policy.mjs'), file], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The fork guard's problems alone (a self-hosted label check may add its own). */
const forkMessages = (/** @type {string} */ text) =>
  messages(text).filter((m) => m.includes("a fork's pull request could reach"));

test('fails a guard that another condition can bypass, or one that only fails a fork', () => {
  const bypass = `  build:\n    if: (${FORK_GUARD}) || true\n    runs-on: [self-hosted, penmoss-mac]\n`;
  assert.equal(forkMessages(workflow(bypass)).length, 1);
  const failing = [
    '  result:',
    '    if: always()',
    '    runs-on: [self-hosted, penmoss-mac]',
    '    permissions: {}',
    '    steps:',
    '      - run: exit 1',
    '',
  ].join('\n');
  assert.equal(forkMessages(workflow(failing)).length, 1);
});

test('treats a runs-on expression as self-hosted for the fork guard, as well as refusing it', () => {
  const found = messages(
    workflow('  check:\n    needs: pick\n    runs-on: ${{ fromJSON(needs.pick.outputs.mac) }}\n'),
  );
  assert.equal(found.length, 2, found.join('; '));
  assert.match(found.join('\n'), /expression/);
  assert.match(found.join('\n'), /a fork's pull request could reach/);
});

test('accepts the guard and-ed in a folded if: with comments', () => {
  const job = `  b:\n    # a comment\n    if: >-\n      (github.event_name != 'pull_request' ||\n      github.event.pull_request.head.repo.full_name == github.repository) &&\n      needs.pick.outputs.check == 'true' # trailing\n    runs-on: [self-hosted, macOS, penmoss-mac]\n`;
  assert.deepEqual(messages(workflow(job)), []);
});

test("guards a reusable workflow, which a pull request's run can call", () => {
  const job = '  a:\n    runs-on: [self-hosted, penmoss-mac]\n';
  assert.equal(forkMessages(workflow(job, 'on:\n  workflow_call:\n')).length, 1);
  assert.deepEqual(
    messages(workflow('  a:\n    runs-on: macos-latest\n', 'on:\n  workflow_call:\n')),
    [],
  );
});

test('fails pull_request_target and workflow_run outright, at the on: line', () => {
  const found = problems(
    workflow(
      '  a:\n    runs-on: ubuntu-latest\n',
      'on:\n  pull_request_target:\n  workflow_run:\n',
    ),
  );
  assert.equal(found.length, 2);
  assert.match(found[0]?.problem ?? '', /pull_request_target/);
  assert.match(found[1]?.problem ?? '', /workflow_run/);
  assert.equal(found[0]?.line, 3);
});

test('fails default permissions that are not read-only', () => {
  const text = workflow('  a:\n    runs-on: ubuntu-latest\n').replace(
    'contents: read',
    'contents: write',
  );
  const found = problems(text);
  assert.equal(found.length, 1);
  assert.match(found[0]?.problem ?? '', /default permissions must be read-only/);
  assert.match(
    messages(
      workflow('  a:\n    runs-on: ubuntu-latest\n').replace(
        'permissions:\n  contents: read\n',
        '',
      ),
    )[0] ?? '',
    /not "unset"/,
  );
});

test('parseWorkflow reads an inline on: list and a block if:', () => {
  const parsed = parseWorkflow(
    workflow(
      `  a:\n    if: >-\n      ${GUARD} &&\n      true\n    runs-on: [self-hosted]\n`,
      'on: [push, pull_request]\n',
    ),
  );
  assert.deepEqual(parsed.triggers, ['push', 'pull_request']);
  assert.match(
    parsed.jobs[0]?.if ?? '',
    /^\(github\.event_name != 'pull_request' \|\| .* && true$/,
  );
});
