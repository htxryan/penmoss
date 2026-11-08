/**
 * T22: offline full-text search within 150 ms on a 5,000-note vault (the
 * same seeded synthetic vault as the server benchmark), snippets included.
 */
import { parseQuery } from '@penmoss/core/search';
import { expect, it } from 'vitest';
import { syntheticVault } from '../../core/test/support/synthetic-vault';
import { LocalSearchIndex } from '../src/local-index';

const NOTES = 5000;
const TARGET_MS = 150;

const fmt = (ms: number) => `${ms < 1 ? ms.toFixed(3) : ms.toFixed(1)} ms`;

it(`answers offline queries on a ${NOTES}-note vault within ${TARGET_MS} ms`, () => {
  const vault = syntheticVault(NOTES);
  const index = new LocalSearchIndex();
  const built = performance.now();
  for (const note of vault) index.add({ ...note, tags: note.tags });
  const buildMs = performance.now() - built;
  const words = vault.flatMap((n) => n.body.split(/\s+/)).slice(0, 50_000);
  const clean = (word: string) => word.replace(/\W/g, '');
  const common = clean(words[0]!);
  const rare = clean([...words].reverse().find((w) => /^\w{8,}$/.test(w))!);
  const cases: Array<[string, string, boolean]> = [
    ['common word', common, false],
    ['rare word', rare, false],
    ['two words', `${common} ${clean(words[7]!)}`, false],
    ['2-letter prefix', `${common.slice(0, 2)}*`, false],
    ['3-letter prefix (completed)', `${rare.slice(0, 3)}*`, false],
    ['4-letter prefix', `${rare.slice(0, 4)}*`, false],
    ['partly typed word', rare.slice(0, -2), true],
    ['phrase', `"${words[10]} ${words[11]}"`, false],
    ['typing (prefix last)', `${common} ${rare.slice(0, 3)}`, true],
  ];
  const lines: string[] = [];
  let worst = 0;
  for (const [name, input, prefixLast] of cases) {
    const query = parseQuery(input, { prefixLast });
    const hits = index.search(query, { limit: 20 }).length;
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      index.search(query, { limit: 20 });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const max = samples.at(-1)!;
    worst = Math.max(worst, max);
    lines.push(
      `  ${name.padEnd(22)} ${String(hits).padStart(3)} hits  p50 ${fmt(samples[5]!)}  max ${fmt(max)}`,
    );
  }
  console.info(
    `[t22] offline index on ${NOTES} notes: built in ${fmt(buildMs)}\n${lines.join('\n')}`,
  );
  expect(worst).toBeLessThan(TARGET_MS);
});
