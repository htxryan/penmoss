/**
 * The Period filter offers the periods the queries take (PEN-137): the page's static options are
 * @penmoss/telemetry's DAYS, the list the API and `task telemetry:query` check against.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAYS } from '@penmoss/telemetry/params';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = join(here, '..', 'src', 'client', 'index.html');

describe('the Period filter', () => {
  it('offers every period in DAYS, in order, and no other', () => {
    const html = readFileSync(PAGE, 'utf8');
    const select = /<select id="filter-days">([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
    const values = [...select.matchAll(/<option value="(\d+)"/g)].map((match) => Number(match[1]));
    expect(values).toEqual([...DAYS]);
  });
});
