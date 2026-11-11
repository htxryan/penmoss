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

/**
 * A card on the board. It carries the factory's opt-in label (A1296) besides any it is given;
 * `optedOut` leaves it off.
 */
export function item(
  number: number,
  overrides: Partial<BoardItem> & { readonly optedOut?: boolean } = {},
): BoardItem {
  const { optedOut, ...rest } = overrides;
  return {
    itemId: `PVTI_${number}`,
    number,
    key: `#${number}`,
    title: `Issue ${number}`,
    url: `https://github.com/htxryan/penmoss/issues/${number}`,
    repo: 'htxryan/penmoss',
    state: 'OPEN',
    author: 'htxryan',
    status: 'Ready',
    blocked: false,
    position: number,
    ...rest,
    labels: [...(optedOut ? [] : ['factory']), ...(rest.labels ?? [])],
  };
}
