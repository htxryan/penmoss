/**
 * The dashboard only reads (PEN-137, AC34): its source holds no SQL statement but SELECT, it
 * prepares no SQL of its own (only the named queries, through runQuery), and each named query it
 * can run is one SELECT. The ingest Worker's batch and forget are the only writes to D1.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, '..', 'src');
const QUERIES = join(here, '..', '..', 'telemetry', 'queries');
const RUNNER = join(here, '..', '..', 'telemetry', 'src', 'queries.ts');

/** Every statement keyword that writes, changes the schema or the connection. */
const WRITES =
  /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|MERGE|CREATE|DROP|ALTER|TRUNCATE|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const sql = (text: string) => text.replace(/--.*$/gm, '').trim();

describe('the dashboard', () => {
  const sources = files(SOURCE).filter((path) => /\.(ts|html|css)$/.test(path));

  it('has source to check', () => {
    expect(sources.some((path) => path.endsWith('index.ts'))).toBe(true);
    expect(sources.some((path) => path.endsWith('main.ts'))).toBe(true);
  });

  it.each(sources.map((path) => [path.slice(SOURCE.length + 1), path]))(
    '%s has no SQL that writes',
    (_name, path) => {
      const text = readFileSync(path, 'utf8');
      // SQL is written in capitals; the page's own words ("Delete") are not.
      expect(text).not.toMatch(WRITES);
      // No SQL of its own: queries go through runQuery and the named files.
      expect(text).not.toMatch(/\.prepare\(|\.exec\(|\.batch\(|\bSELECT\b/);
    },
  );
});

describe('the named queries it runs', () => {
  const names = readdirSync(QUERIES).filter((name) => name.endsWith('.sql'));

  it.each(names)('%s is one SELECT', (name) => {
    const text = sql(readFileSync(join(QUERIES, name), 'utf8'));
    expect(text).toMatch(/^(WITH|SELECT)\b/);
    expect(text.toUpperCase()).not.toMatch(WRITES);
    expect(text.indexOf(';')).toBe(text.length - 1);
  });

  it('are run by one prepare, of a named query only', () => {
    const runner = readFileSync(RUNNER, 'utf8');
    expect(runner.match(/\.prepare\(/g)).toHaveLength(1);
    expect(runner).toMatch(
      /const sql = NAMED_QUERIES\[name\];\s+const result = await db\s+\.prepare\(sql\)/,
    );
    expect(runner).not.toMatch(WRITES);
  });
});
