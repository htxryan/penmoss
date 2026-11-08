import { loadConfig, withTracker, type FactoryConfig } from '../src/config.ts';
import type { BoardItem } from '../src/board.ts';

/** The checked-in config on GitHub's tracker, which most tests are written against. */
export function testConfig(): FactoryConfig {
  const loaded = loadConfig();
  if (!loaded.ok) throw new Error(loaded.error);
  return withTracker(loaded.config, 'github');
}

/** The checked-in config on Linear's tracker, with an owner set. */
export function linearConfig(): FactoryConfig {
  const loaded = loadConfig();
  if (!loaded.ok) throw new Error(loaded.error);
  const config = withTracker(loaded.config, 'linear');
  return { ...config, linear: { ...config.linear, owner: RYAN_LINEAR } };
}

export const RYAN_LINEAR = '0b5e8c3a-1d2f-4a6b-9c7d-112233445566';

export function item(number: number, overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    itemId: `PVTI_${number}`,
    number,
    key: `#${number}`,
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
