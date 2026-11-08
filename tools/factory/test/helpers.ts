import { loadConfig, type FactoryConfig } from '../src/config.ts';
import type { BoardItem } from '../src/board.ts';

export function testConfig(): FactoryConfig {
  const loaded = loadConfig();
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.config;
}

export function item(number: number, overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    itemId: `PVTI_${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/htxryan/penmoss/issues/${number}`,
    repo: 'htxryan/penmoss',
    state: 'OPEN',
    author: 'htxryan',
    labels: [],
    status: 'Ready',
    blocked: false,
    position: number,
    ...overrides,
  };
}
