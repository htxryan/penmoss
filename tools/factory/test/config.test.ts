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

  it("checks the Mac proof's VM and how long a run waits for it (F10)", () => {
    const loaded = loadConfig();
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.config.macProof).toEqual({ vm: 'penmoss-test', waitHours: 12 });
    expect(parseConfig({ ...loaded.config, macProof: { vm: 'penmoss-test' } })).toEqual({
      ok: false,
      error: 'config.macProof.waitHours must be an integer of at least 1',
    });
    expect(
      parseConfig({ ...loaded.config, macProof: { vm: 'a vm; rm -rf ~', waitHours: 12 } }),
    ).toEqual({
      ok: false,
      error: 'config.macProof.vm must be a Tart VM name (letters, digits, . _ -)',
    });
  });

  it('runs Claude on Opus 5.5 at high effort, and checks the effort (A1363)', () => {
    const loaded = loadConfig();
    if (!loaded.ok) throw new Error(loaded.error);
    const { models, agents } = loaded.config;
    expect(models[agents.claude.defaultModel]).toEqual({
      agent: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    for (const alias of Object.values(models))
      if (alias.agent === 'claude') expect(alias.effort).toBe('high');
    const bad = { ...models, opus: { agent: 'claude', model: 'claude-opus-5-5', effort: 'huge' } };
    expect(parseConfig({ ...loaded.config, models: bad })).toEqual({
      ok: false,
      error: 'config.models.opus.effort must be one of low, medium, high, xhigh, max',
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
