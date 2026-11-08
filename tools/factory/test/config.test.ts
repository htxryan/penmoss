import { describe, expect, it } from 'vitest';
import { expandHome, loadConfig, parseConfig } from '../src/config.ts';

describe('config', () => {
  it('loads the checked-in factory.config.json', () => {
    const loaded = loadConfig();
    expect(loaded.ok).toBe(true);
  });

  it('names the first problem in a bad file', () => {
    const loaded = loadConfig();
    if (!loaded.ok) throw new Error(loaded.error);
    expect(parseConfig({ ...loaded.config, repo: 'nope' })).toEqual({
      ok: false,
      error: 'config.repo must look like owner/name',
    });
    expect(parseConfig({ ...loaded.config, maxConcurrent: 0 })).toEqual({
      ok: false,
      error: 'config.maxConcurrent must be an integer of at least 1',
    });
    const agents = { ...loaded.config.agents, claude: { bin: 'claude', defaultModel: 'go' } };
    expect(parseConfig({ ...loaded.config, agents })).toEqual({
      ok: false,
      error: 'config.agents.claude.defaultModel must name a claude alias in config.models',
    });
  });

  it('rejects a non-object', () => {
    expect(parseConfig([]).ok).toBe(false);
  });

  it('expands ~/', () => {
    expect(expandHome('~/x/y', '/Users/u')).toBe('/Users/u/x/y');
    expect(expandHome('/abs', '/Users/u')).toBe('/abs');
  });
});
