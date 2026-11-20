/// <reference types="node" />
/**
 * AI Descriptions (PEN-161 T6): apps/android/contract/ai-descriptions-v1.json is core's default
 * prompt, its tokens, Anthropic's models and the pauses, so the phone's Settings offers and resets
 * to what the Mac does. The Kotlin `AiDescriptionsContractTest` checks the app's copy against it.
 *
 * After changing `packages/core/src/ai-description.ts`, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/android-editor test ai-descriptions-contract`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ANTHROPIC_MODELS,
  DEFAULT_PROMPT,
  PAUSE_CHOICES_SECONDS,
  PROMPT_TOKENS,
} from '@penmoss/core/ai-description';
import { describe, expect, it } from 'vitest';
import contract from '../../contract/ai-descriptions-v1.json';

describe('AI Descriptions contract v1', () => {
  it('is core’s prompt, tokens, models and pauses', () => {
    const expected = {
      version: 1,
      defaultPrompt: DEFAULT_PROMPT,
      tokens: PROMPT_TOKENS.map((token) => `{{${token}}}`),
      models: ANTHROPIC_MODELS.map((model) => ({ id: model.id, label: model.label })),
      pauses: [...PAUSE_CHOICES_SECONDS],
    };
    if (process.env['PENMOSS_WRITE_CONTRACTS']) {
      const file = resolve(process.cwd(), '../contract/ai-descriptions-v1.json');
      writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
    }
    expect(contract).toEqual(expected);
  });
});
