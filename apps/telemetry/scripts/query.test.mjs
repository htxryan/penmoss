// `task telemetry:query` (PEN-137): the named queries with their values written in safely, and
// the rows printed as a table. Running them is the workerd tests' (test/queries.test.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
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

test('a value that could end its literal is refused', () => {
  assert.throws(() => inline('SELECT ?1', ["x' OR 1=1 --"]), /no safe value/);
  assert.throws(() => inline('SELECT ?2', [1]), /no safe value/);
  assert.throws(() => parseArgs(['active', '--client', "mac'"]), /--client/);
  assert.throws(() => parseArgs(['active', '--days', '12']), /--days/);
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
