/// <reference types="node" />
/**
 * AI Descriptions (PEN-161 T6): apps/android/contract/ai-descriptions-v1.json is core's default
 * prompt, its tokens, the tag prompt and its tokens (A1677), Anthropic's models and the pauses, so the phone's Settings offers and resets
 * to what the Mac does; and the words both say about descriptions (`AI_DESCRIPTION_COPY`, with
 * Generate All's sentence for a few counts) and the longest tag description kept (A1677, A1646).
 * The Kotlin `AiDescriptionsContractTest` checks the app's copy against it.
 *
 * After changing `packages/core/src/ai-description.ts`, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/android-editor test ai-descriptions-contract`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AI_DESCRIPTION_COPY,
  ANTHROPIC_MODELS,
  DEFAULT_PROMPT,
  DEFAULT_TAG_PROMPT,
  generateAllTagsWords,
  PAUSE_CHOICES_SECONDS,
  PROMPT_TOKENS,
  TAG_PROMPT_TOKENS,
} from '@penmoss/core/ai-description';
import { TAG_DESCRIPTION_MAX } from '@penmoss/core/tags';
import { describe, expect, it } from 'vitest';
import contract from '../../contract/ai-descriptions-v1.json';

describe('AI Descriptions contract v1', () => {
  it('is core’s prompts, tokens, models, pauses and words', () => {
    const expected = {
      version: 1,
      defaultPrompt: DEFAULT_PROMPT,
      tokens: PROMPT_TOKENS.map((token) => `{{${token}}}`),
      // A tag's description (A1677).
      defaultTagPrompt: DEFAULT_TAG_PROMPT,
      tagTokens: TAG_PROMPT_TOKENS.map((token) => `{{${token}}}`),
      models: ANTHROPIC_MODELS.map((model) => ({ id: model.id, label: model.label })),
      pauses: [...PAUSE_CHOICES_SECONDS],
      // The words the Mac and Android share, and the longest tag description (A1677, A1646).
      copy: { ...AI_DESCRIPTION_COPY },
      generateAll: [0, 1, 2].flatMap((count) =>
        [false, true].map((replace) => ({
          count,
          replace,
          words: generateAllTagsWords(count, replace),
        })),
      ),
      tagDescriptionMax: TAG_DESCRIPTION_MAX,
    };
    if (process.env['PENMOSS_WRITE_CONTRACTS']) {
      const file = resolve(process.cwd(), '../contract/ai-descriptions-v1.json');
      writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
    }
    expect(contract).toEqual(expected);
  });
});
