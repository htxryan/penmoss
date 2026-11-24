// `task telemetry:query` (PEN-137): the named queries with their values written in safely, and
// the rows printed as a table. Running them is the workerd tests' (test/queries.test.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAYS } from '../src/params.ts';
import { inline, parseArgs, queryNames, querySql, table } from './query.mjs';

test('every named query is listed, and each comes out with every ?N written in', () => {
  const names = queryNames();
  for (const name of ['active', 'commands', 'next', 'gave-up', 'health']) {
    assert.ok(names.includes(name), name);
  }
  const options = parseArgs(['--today', '2026-11-19', '--client', 'mac']);
  for (const name of names) {
    const sql = querySql(name, options);
    assert.doesNotMatch(sql, /\?\d/, name);
    assert.doesNotMatch(sql, /^\s*--/m, name);
  }
  assert.match(querySql('health', options), /date\('2026-11-19', '-' \|\| 30 \|\| ' days'\)/);
  assert.match(querySql('next', options), /kind = 'command' AND name = 'app\.palette'/);
});

test('the Sessions queries take an install, a session and a page (PEN-173)', () => {
  const install = 'a0'.repeat(16);
  const session = '0000000100000002';
  const options = parseArgs([
    'session',
    '--today',
    '2026-11-19',
    '--install',
    install,
    '--session',
    session,
  ]);
  assert.match(
    querySql('session', options),
    new RegExp(`install = '${install}' AND session = '${session}'`),
  );
  assert.match(querySql('install-sessions', options), new RegExp(`WHERE session = '${session}'`));
  assert.match(
    querySql('sessions', parseArgs(['sessions', '--page', '3'])),
    /OFFSET \(3 - 1\) \* 50/,
  );
  assert.match(querySql('sessions', parseArgs(['sessions'])), /OFFSET \(1 - 1\) \* 50/);
  assert.throws(() => parseArgs(['session', '--install', 'A0'.repeat(16)]), /--install/);
  assert.throws(() => parseArgs(['session', '--install', "a0' OR 1=1"]), /--install/);
  assert.throws(() => parseArgs(['session', '--session', '123']), /--session/);
  assert.throws(() => parseArgs(['sessions', '--page', '0']), /--page/);
  assert.throws(() => parseArgs(['sessions', '--page', '10000']), /--page/);
  assert.throws(() => parseArgs(['sessions', '--page', '1.5']), /--page/);
});

test('a value that could end its literal is refused', () => {
  assert.throws(() => inline('SELECT ?1', ["x' OR 1=1 --"]), /no safe value/);
  assert.throws(() => inline('SELECT ?2', [1]), /no safe value/);
  assert.throws(() => parseArgs(['active', '--client', "mac'"]), /--client/);
  assert.throws(() => parseArgs(['active', '--days', '12']), /--days/);
  for (const days of DAYS) assert.equal(parseArgs(['active', '--days', String(days)]).days, days);
  assert.throws(() => parseArgs(['active', '--start', 'nope']), /--start/);
  assert.throws(() => parseArgs(['active', '--wat']), /unknown argument/);
  assert.equal(inline('SELECT ?1, ?2 -- ?3', [7, 'mac']), "SELECT 7, 'mac'");
});

test('rows print as a table', () => {
  assert.equal(
    table([
      { client: 'mac', installs: 12 },
      { client: 'android', installs: null },
    ]),
    ['client   installs', '-------  --------', 'mac      12', 'android'].join('\n'),
  );
  assert.equal(table([]), '(no rows)');
});
