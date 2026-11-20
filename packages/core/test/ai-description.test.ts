import { describe, expect, it } from 'vitest';
import {
  aiDescriptionSettingProblem,
  aiGlobalOf,
  aiProviderOf,
  cleanDescription,
  cutForPrompt,
  DEFAULT_PAUSE_SECONDS,
  DEFAULT_PROMPT,
  describedTextHash,
  describeWhenOf,
  folderLevels,
  modelOf,
  pauseSecondsOf,
  promptHasBody,
  promptOf,
  renderPrompt,
  resolveAiDescription,
  type AiLevels,
} from '../src/ai-description';
import { isLocalSetting, isNotebookSetting } from '../src/settings';
import type { FolderRecord } from '../src/workspace';

const levels = (over: Partial<AiLevels> = {}): AiLevels => ({
  note: 'inherit',
  folders: [],
  notebook: { name: 'Personal', value: 'inherit' },
  global: false,
  ...over,
});

const folder = (
  id: string,
  parentId: string | null,
  aiDescription?: 'on' | 'off',
): FolderRecord => ({
  id,
  name: id.toUpperCase(),
  parentId,
  position: 'a0',
  sortMode: 'manual',
  ...(aiDescription ? { aiDescription } : {}),
});

describe('resolveAiDescription', () => {
  it('falls back to the global value, Off unset', () => {
    expect(resolveAiDescription(levels())).toEqual({ on: false, source: { level: 'global' } });
    expect(resolveAiDescription(levels({ global: true })).on).toBe(true);
  });

  it('takes the closest value that is not Inherit', () => {
    const folders = [
      { id: 'p', name: 'Projects', value: 'inherit' as const },
      { id: 'w', name: 'Work', value: 'on' as const },
    ];
    expect(resolveAiDescription(levels({ folders }))).toEqual({
      on: true,
      source: { level: 'folder', id: 'w', name: 'Work' },
    });
    expect(resolveAiDescription(levels({ folders, note: 'off' }))).toEqual({
      on: false,
      source: { level: 'note' },
    });
    expect(
      resolveAiDescription(levels({ notebook: { name: 'Personal', value: 'on' } })).source,
    ).toEqual({ level: 'notebook', name: 'Personal' });
  });

  it('walks parent folders by the tree', () => {
    const folders = [folder('w', null, 'off'), folder('p', 'w'), folder('d', 'p')];
    expect(folderLevels(folders, 'd').map((f) => [f.id, f.value])).toEqual([
      ['d', 'inherit'],
      ['p', 'inherit'],
      ['w', 'off'],
    ]);
    expect(folderLevels(folders, null)).toEqual([]);
    // A cycle never loops.
    expect(folderLevels([folder('a', 'b'), folder('b', 'a')], 'a').length).toBeLessThanOrEqual(2);
  });
});

describe('settings', () => {
  it('reads defaults for unset or bad values', () => {
    expect(aiGlobalOf({})).toBe(false);
    expect(describeWhenOf({})).toBe('pause');
    expect(describeWhenOf({ 'ai.description.when': 'sync' })).toBe('sync');
    expect(pauseSecondsOf({ 'ai.description.pause': 'x' })).toBe(DEFAULT_PAUSE_SECONDS);
    expect(pauseSecondsOf({ 'ai.description.pause': 30 })).toBe(30);
    expect(aiProviderOf({})).toBe('none');
    expect(aiProviderOf({ 'ai.provider': 'claude-code' })).toBe('claude-code');
    expect(aiProviderOf({ 'ai.provider': 'gpt' })).toBe('none');
    expect(promptOf({ 'ai.description.prompt': '  ' })).toBe(DEFAULT_PROMPT);
  });

  it('uses the chosen model only when the provider offers it', () => {
    expect(modelOf({}, 'anthropic')).toBe('claude-haiku-5-5');
    expect(modelOf({ 'ai.description.model': 'sonnet' }, 'claude-code')).toBe('sonnet');
    expect(modelOf({ 'ai.description.model': 'sonnet' }, 'anthropic')).toBe('claude-haiku-5-5');
    expect(modelOf({}, 'none')).toBeNull();
  });

  it('validates each key', () => {
    expect(aiDescriptionSettingProblem('ai.description.global', true)).toBeNull();
    expect(aiDescriptionSettingProblem('ai.description.global', 'on')).not.toBeNull();
    expect(aiDescriptionSettingProblem('ai.description', 'on')).toBeNull();
    expect(aiDescriptionSettingProblem('ai.description.pause', 2)).not.toBeNull();
    expect(aiDescriptionSettingProblem('ai.provider', 'anthropic')).toBeNull();
    expect(aiDescriptionSettingProblem('ai.provider', 'x')).not.toBeNull();
    expect(aiDescriptionSettingProblem('ai.description.when', null)).toBeNull();
  });

  it('keeps the notebook value in the notebook and the provider on the device', () => {
    expect(isNotebookSetting('ai.description')).toBe(true);
    expect(isNotebookSetting('ai.description.global')).toBe(false);
    expect(isLocalSetting('ai.provider')).toBe(true);
    expect(isLocalSetting('ai.description.prompt')).toBe(false);
  });
});

describe('the prompt', () => {
  const values = {
    title: 'Plans',
    body: 'Body text',
    tags: '#work',
    folder: 'Work',
    notebook: 'Personal',
    description: '',
    date: '2026-11-20',
  };

  it('fills every token and leaves unknown ones as typed', () => {
    expect(
      renderPrompt('{{title}}|{{ body }}|{{tags}}|{{folder}}|{{notebook}}|{{date}}|{{x}}', values),
    ).toBe('Plans|Body text|#work|Work|Personal|2026-11-20|{{x}}');
    expect(promptHasBody(DEFAULT_PROMPT)).toBe(true);
    expect(promptHasBody('{{title}}')).toBe(false);
  });

  it('cuts a long note, keeping its start and end', () => {
    const body = `START${'x'.repeat(1000)}END`;
    const cut = cutForPrompt(body, 100);
    expect(cut.length).toBeLessThanOrEqual(400);
    expect(cut.startsWith('START')).toBe(true);
    expect(cut.endsWith('END')).toBe(true);
    expect(cut).toContain('left out');
    expect(cutForPrompt('short', 100)).toBe('short');
  });
});

describe('describedTextHash', () => {
  it('changes with title, tags or body, not tag order', () => {
    const base = describedTextHash('T', ['a', 'b'], 'body');
    expect(describedTextHash('T', ['b', 'a'], 'body')).toBe(base);
    expect(describedTextHash('U', ['a', 'b'], 'body')).not.toBe(base);
    expect(describedTextHash('T', ['a'], 'body')).not.toBe(base);
    expect(describedTextHash('T', ['a', 'b'], 'body.')).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('cleanDescription', () => {
  it('makes one plain line', () => {
    expect(cleanDescription('  "Notes on\n the sync design."  ')).toBe('Notes on the sync design.');
    expect(cleanDescription('Description: Plans.')).toBe('Plans.');
    expect(cleanDescription('   ')).toBeNull();
    expect(cleanDescription('word '.repeat(300))!.length).toBeLessThanOrEqual(601);
  });
});
