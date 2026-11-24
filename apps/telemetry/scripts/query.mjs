#!/usr/bin/env node
// Usage analytics' named queries from a terminal (PEN-137): `task telemetry:query -- <name>`
// runs queries/<name>.sql against the production D1 through `wrangler d1 execute --remote` and
// prints a table; `task telemetry:sql -- "<SQL>"` runs any SQL the same way.
//
//   node scripts/query.mjs active --days 90 --client mac
//   node scripts/query.mjs next --start command:app.palette
//   node scripts/query.mjs sessions --page 2
//   node scripts/query.mjs session --install <32 hex> --session <16 hex>
//   node scripts/query.mjs --sql "SELECT COUNT(*) AS events FROM events"
//   add --local for `wrangler dev`'s local database, --json for the rows as JSON
//
// `wrangler d1 execute` can't bind parameters, so each ?N is written in as a literal: a whole
// number, or a string of letters, digits and . _ : + - only, so a value can never end the
// literal it is written into.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The parameters' order, periods and id checks the Worker and the dashboard use (Node strips
// the file's types).
import { DAYS, INSTALL_HEX, SESSION_HEX, isDays, queryValues } from '../src/params.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const QUERIES = join(root, 'queries');
export const DATABASE = 'penmoss-telemetry';

/** The names of the queries in queries/. */
export function queryNames() {
  return readdirSync(QUERIES)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => basename(file, '.sql'))
    .sort();
}

const SAFE = /^[A-Za-z0-9._:+-]*$/;

/**
 * The options from the command line.
 * @param {readonly string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ name?: string; sql?: string; local: boolean; json: boolean; days: number; client: string; actor: string; channel: string; version: string; today: string; start: string; install: string; session: string; page: number }} */
  const options = {
    local: false,
    json: false,
    days: 30,
    client: '',
    actor: '',
    channel: '',
    version: '',
    today: new Date().toISOString().slice(0, 10),
    start: 'command:app.palette',
    install: '',
    session: '',
    page: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = /** @type {string} */ (argv[i]);
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--local') options.local = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--sql') options.sql = value();
    else if (arg === '--days') options.days = Number(value());
    else if (arg === '--client') options.client = value();
    else if (arg === '--actor') options.actor = value();
    else if (arg === '--channel') options.channel = value();
    else if (arg === '--version') options.version = value();
    else if (arg === '--today') options.today = value();
    else if (arg === '--start') options.start = value();
    else if (arg === '--install') options.install = value();
    else if (arg === '--session') options.session = value();
    else if (arg === '--page') options.page = Number(value());
    else if (!arg.startsWith('--') && options.name === undefined) options.name = arg;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!isDays(options.days)) throw new Error(`--days is one of ${DAYS.join(', ')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.today)) throw new Error('--today is YYYY-MM-DD');
  if (!/^[a-z]+:[A-Za-z0-9_.-]+$/.test(options.start)) throw new Error('--start is kind:name');
  // The Sessions tab's (PEN-173): an install's 32 hex characters, a session's 16, a page 1–9999.
  if (options.install !== '' && !INSTALL_HEX.test(options.install)) {
    throw new Error('--install is 32 hex characters');
  }
  if (options.session !== '' && !SESSION_HEX.test(options.session)) {
    throw new Error('--session is 16 hex characters');
  }
  if (!Number.isInteger(options.page) || options.page < 1 || options.page > 9999) {
    throw new Error('--page is a whole number from 1 to 9999');
  }
  for (const key of /** @type {const} */ (['client', 'actor', 'channel', 'version'])) {
    if (!SAFE.test(options[key])) throw new Error(`--${key} has a character it can't have`);
  }
  return options;
}

/**
 * `sql` with its comments gone and each ?N written in as a literal.
 * @param {string} sql
 * @param {readonly (string | number)[]} values ?1, ?2, … in order
 */
export function inline(sql, values) {
  const code = sql.replace(/--.*$/gm, '').trim();
  return code.replace(/\?(\d+)/g, (_match, digits) => {
    const value = values[Number(digits) - 1];
    if (typeof value === 'number' && Number.isInteger(value)) return String(value);
    if (typeof value === 'string' && SAFE.test(value)) return `'${value}'`;
    throw new Error(`?${digits} has no safe value`);
  });
}

/**
 * The SQL to run for `name` with `options`.
 * @param {string} name
 * @param {ReturnType<typeof parseArgs>} options
 */
export function querySql(name, options) {
  if (!queryNames().includes(name)) {
    throw new Error(`no query named "${name}" (${queryNames().join(', ')})`);
  }
  const [startKind, startName] = options.start.split(':');
  return inline(
    readFileSync(join(QUERIES, `${name}.sql`), 'utf8'),
    queryValues({
      days: options.days,
      client: options.client,
      actor: options.actor,
      channel: options.channel,
      version: options.version,
      today: options.today,
      startKind: startKind ?? '',
      startName: startName ?? '',
      install: options.install,
      session: options.session,
      page: options.page,
    }),
  );
}

/**
 * Rows as a plain table: a header, a rule, a line per row.
 * @param {readonly Record<string, unknown>[]} rows
 */
export function table(rows) {
  if (rows.length === 0) return '(no rows)';
  const columns = Object.keys(rows[0] ?? {});
  const text = (/** @type {unknown} */ value) => (value === null ? '' : String(value));
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => text(row[column]).length)),
  );
  const line = (/** @type {string[]} */ cells) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    line(columns),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => line(columns.map((column) => text(row[column])))),
  ].join('\n');
}

/**
 * Runs `sql` through wrangler and returns its rows.
 * @param {string} sql
 * @param {boolean} local
 * @returns {Record<string, unknown>[]}
 */
function execute(sql, local) {
  const out = execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      DATABASE,
      local ? '--local' : '--remote',
      '--json',
      '--command',
      sql,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const parsed = /** @type {{ results?: Record<string, unknown>[] }[]} */ (JSON.parse(out));
  return parsed.flatMap((result) => result.results ?? []);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let sql = options.sql;
  if (sql === undefined) {
    if (options.name === undefined) {
      console.error(`usage: query.mjs <name> [--days 30] [--client …] [--local] [--json]`);
      console.error(`queries: ${queryNames().join(', ')}`);
      process.exitCode = 2;
      return;
    }
    sql = querySql(options.name, options);
  }
  const rows = execute(sql, options.local);
  console.log(options.json ? JSON.stringify(rows, null, 2) : table(rows));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`query.mjs: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
