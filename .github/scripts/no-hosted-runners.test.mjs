import assert from 'node:assert/strict';
import { test } from 'node:test';
import { problems } from './no-hosted-runners.mjs';

test('passes self-hosted label lists in every form', () => {
  assert.deepEqual(
    problems('jobs:\n  a:\n    runs-on: [self-hosted, macOS, ARM64, penmoss-mac]\n'),
    [],
  );
  assert.deepEqual(problems('jobs:\n  a:\n    runs-on: [\'self-hosted\', "penmoss-mac"]\n'), []);
  assert.deepEqual(
    problems(
      'jobs:\n  a:\n    runs-on:\n      - self-hosted\n      - penmoss-mac\n    steps: []\n',
    ),
    [],
  );
});

test('fails on a hosted runner, even in a job that is off', () => {
  const text = 'jobs:\n  desktop:\n    if: false\n    runs-on: ubuntu-latest\n';
  assert.deepEqual(problems(text), [{ line: 4, problem: 'GitHub-hosted runner ubuntu-latest' }]);
  assert.equal(problems('    runs-on: [macos-14]\n')[0]?.problem, 'GitHub-hosted runner macos-14');
  assert.equal(
    problems('    runs-on:\n      - windows-2022\n')[0]?.problem,
    'GitHub-hosted runner windows-2022',
  );
});

test('fails on an expression, which could pick a hosted runner at run time', () => {
  assert.match(
    problems('    runs-on: ${{ fromJSON(needs.pick.outputs.mac) }}\n')[0]?.problem ?? '',
    /expression/,
  );
  assert.match(problems('    runs-on: ${{ matrix.os }}\n')[0]?.problem ?? '', /expression/);
});

test('fails on a list without self-hosted', () => {
  assert.equal(
    problems('    runs-on: [penmoss-mac]\n')[0]?.problem,
    "runs-on penmoss-mac isn't self-hosted",
  );
});
