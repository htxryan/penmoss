import { describe, expect, it } from 'vitest';
import { parseIssueSpec, priorityOf } from '../src/labels.ts';
import { testConfig } from './helpers.ts';

const config = testConfig();

describe('parseIssueSpec', () => {
  it('defaults to Claude Code on its default model, planning first, classifier scope, P3', () => {
    expect(parseIssueSpec(['bug'], config)).toEqual({
      ok: true,
      spec: {
        agent: 'claude',
        modelAlias: 'opus',
        model: 'opus',
        planSkip: false,
        platforms: null,
        priority: 3,
      },
    });
  });

  it('reads agent, model, plan:skip, platforms and priority', () => {
    const result = parseIssueSpec(
      ['agent:claude', 'model:sonnet', 'plan:skip', 'platform:android', 'platform:web', 'P1'],
      config,
    );
    expect(result).toEqual({
      ok: true,
      spec: {
        agent: 'claude',
        modelAlias: 'sonnet',
        model: 'sonnet',
        planSkip: true,
        platforms: ['web', 'android'],
        priority: 1,
      },
    });
  });

  it('gives agent:opencode its default model', () => {
    const result = parseIssueSpec(['agent:opencode'], config);
    expect(result.ok && result.spec.modelAlias).toBe('go');
  });

  it('infers the agent from a model label alone', () => {
    const result = parseIssueSpec(['model:go'], config);
    expect(result.ok && result.spec.agent).toBe('opencode');
  });

  it.each([
    [['agent:claude', 'agent:opencode'], 'conflicting labels agent:claude and agent:opencode'],
    [['model:opus', 'model:sonnet'], 'conflicting labels model:opus and model:sonnet'],
    [['agent:codex'], 'unknown agent label agent:codex'],
    [['model:gpt'], 'unknown model label model:gpt'],
    [['agent:claude', 'model:go'], 'model:go runs on opencode, not agent:claude'],
    [['platform:ios'], 'unknown platform label platform:ios'],
  ])('rejects %j', (labels, error) => {
    const result = parseIssueSpec(labels, config);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(error);
  });
});

describe('priorityOf', () => {
  it('takes the highest priority label', () => {
    expect(priorityOf(['P4', 'P2'])).toBe(2);
  });
  it('treats an unlabelled issue as P3', () => {
    expect(priorityOf(['bug'])).toBe(3);
  });
  it('ignores look-alike labels', () => {
    expect(priorityOf(['P5', 'P1x'])).toBe(3);
  });
});
