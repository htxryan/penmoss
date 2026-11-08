// The fork guard (P10, A1183) against fixture workflows and the real ones: `task workflows:test`.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FORK_GUARD, checkWorkflows, guardProblems, parseWorkflow } from './workflow-guard.mjs';

const workflows = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows');

/** @param {string} jobs */
const workflow = (jobs, on = 'on:\n  pull_request:\n  push:\n    branches: [main]\n') =>
  `name: Fixture\n\n${on}\npermissions:\n  contents: read\n\njobs:\n${jobs}`;

describe('the fork guard', () => {
  it('passes on the real workflows', () => {
    assert.deepEqual(checkWorkflows(workflows), []);
  });

  it('fails a self-hosted job with no if:', () => {
    const problems = guardProblems(
      parseWorkflow(
        workflow(
          '  build:\n    runs-on: [self-hosted, macOS, ARM64, penmoss-mac]\n    steps: []\n',
        ),
      ),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /job build runs on a self-hosted runner without the fork guard/);
  });

  it('fails a self-hosted job whose if: lacks the guard', () => {
    const jobs =
      "  build:\n    if: github.event_name == 'pull_request'\n    runs-on: [self-hosted]\n";
    assert.equal(guardProblems(parseWorkflow(workflow(jobs))).length, 1);
  });

  it('fails a guard that another condition can bypass', () => {
    const jobs = `  build:\n    if: (${FORK_GUARD}) || true\n    runs-on: [self-hosted]\n`;
    assert.equal(guardProblems(parseWorkflow(workflow(jobs))).length, 1);
  });

  it('treats a runs-on expression as self-hosted (the pick job names the Macs)', () => {
    const jobs =
      '  check:\n    needs: pick\n    runs-on: ${{ fromJSON(needs.pick.outputs.mac) }}\n';
    assert.equal(guardProblems(parseWorkflow(workflow(jobs))).length, 1);
  });

  it('accepts the guard alone, and the guard and-ed in a folded if:', () => {
    const jobs = [
      `  a:\n    if: ${FORK_GUARD}\n    runs-on: [self-hosted]\n`,
      `  b:\n    # a comment\n    if: >-\n      (github.event_name != 'pull_request' ||\n      github.event.pull_request.head.repo.full_name == github.repository) &&\n      needs.pick.outputs.check == 'true' # trailing\n    runs-on: [self-hosted, macOS]\n`,
    ].join('\n');
    assert.deepEqual(guardProblems(parseWorkflow(workflow(jobs))), []);
  });

  it('allows no self-hosted job without the guard, even one that only fails a fork', () => {
    const failing = [
      '  result:',
      '    if: always()',
      '    runs-on: [self-hosted]',
      '    permissions: {}',
      '    steps:',
      '      - run: exit 1',
      '',
    ].join('\n');
    assert.equal(guardProblems(parseWorkflow(workflow(failing))).length, 1);
  });

  it('ignores GitHub-hosted jobs and jobs that never run', () => {
    const jobs =
      '  lint:\n    runs-on: ubuntu-latest\n\n  off:\n    if: false\n    runs-on: [self-hosted]\n';
    assert.deepEqual(guardProblems(parseWorkflow(workflow(jobs))), []);
  });

  it('needs no guard in a workflow that never runs on pull requests', () => {
    const jobs = '  release:\n    runs-on: [self-hosted]\n';
    const on = "on:\n  push:\n    tags: ['v*']\n";
    assert.deepEqual(guardProblems(parseWorkflow(workflow(jobs, on))), []);
  });

  it('reads an inline on: list', () => {
    const jobs = '  build:\n    runs-on: [self-hosted]\n';
    assert.equal(
      guardProblems(parseWorkflow(workflow(jobs, 'on: [push, pull_request]\n'))).length,
      1,
    );
  });

  it('fails pull_request_target and workflow_run outright', () => {
    const text = workflow(
      '  a:\n    runs-on: ubuntu-latest\n',
      'on:\n  pull_request_target:\n  workflow_run:\n',
    );
    const problems = guardProblems(parseWorkflow(text));
    assert.equal(problems.length, 2);
    assert.match(problems[0], /pull_request_target/);
    assert.match(problems[1], /workflow_run/);
  });

  it('fails default permissions that are not read-only', () => {
    const text = workflow('  a:\n    runs-on: ubuntu-latest\n').replace(
      'contents: read',
      'contents: write',
    );
    assert.match(guardProblems(parseWorkflow(text))[0], /default permissions must be read-only/);
  });
});
