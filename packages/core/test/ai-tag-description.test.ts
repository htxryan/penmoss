import { describe, expect, it } from 'vitest';
import {
  AI_DESCRIPTION_COPY,
  aiDescriptionSettingProblem,
  AI_DESCRIPTION_SETTING_KEYS,
  AI_TAG_PROMPT_SETTING,
  DEFAULT_TAG_PROMPT,
  generateAllTagsWords,
  promptHasNotes,
  renderTagPrompt,
  tagPrompt,
  tagPromptOf,
  tagPromptValues,
  tagsToDescribe,
  TAG_NOTE_CHARS,
  TAG_PROMPT_MAX_NOTES,
  TAG_PROMPT_MAX_TAGS,
  TAG_PROMPT_TOKENS,
  type TagPromptInput,
  type TagPromptNote,
} from '../src/ai-description';
import { isLocalSetting } from '../src/settings';

// A tag's AI description (A1677): its prompt, its tokens and what each says.

const note = (title: string, tags: string[], over: Partial<TagPromptNote> = {}): TagPromptNote => ({
  title,
  tags,
  ...over,
});

const input = (notes: TagPromptNote[], over: Partial<TagPromptInput> = {}): TagPromptInput => ({
  tag: 'garden',
  notes,
  notebook: 'Personal',
  date: '2026-11-24',
  ...over,
});

describe('the tag prompt setting', () => {
  it('is the default until it has text, and syncs', () => {
    expect(tagPromptOf({})).toBe(DEFAULT_TAG_PROMPT);
    expect(tagPromptOf({ [AI_TAG_PROMPT_SETTING]: '  ' })).toBe(DEFAULT_TAG_PROMPT);
    expect(tagPromptOf({ [AI_TAG_PROMPT_SETTING]: 'Mine: {{tag}}' })).toBe('Mine: {{tag}}');
    expect(AI_TAG_PROMPT_SETTING).toBe('ai.description.tagPrompt');
    expect(AI_DESCRIPTION_SETTING_KEYS).toContain(AI_TAG_PROMPT_SETTING);
    expect(isLocalSetting(AI_TAG_PROMPT_SETTING)).toBe(false);
  });

  it('is validated as the note prompt is', () => {
    expect(aiDescriptionSettingProblem(AI_TAG_PROMPT_SETTING, 'text')).toBeNull();
    expect(aiDescriptionSettingProblem(AI_TAG_PROMPT_SETTING, null)).toBeNull();
    expect(aiDescriptionSettingProblem(AI_TAG_PROMPT_SETTING, 3)).not.toBeNull();
    expect(aiDescriptionSettingProblem(AI_TAG_PROMPT_SETTING, 'x'.repeat(20_001))).not.toBeNull();
  });

  it('offers every token, and the default uses the tag, the notes and the other tags', () => {
    expect(TAG_PROMPT_TOKENS).toEqual([
      'tag',
      'notes',
      'tags',
      'count',
      'notebook',
      'description',
      'date',
    ]);
    for (const token of ['tag', 'notes', 'tags', 'count', 'notebook']) {
      expect(DEFAULT_TAG_PROMPT).toContain(`{{${token}}}`);
    }
    expect(promptHasNotes(DEFAULT_TAG_PROMPT)).toBe(true);
    expect(promptHasNotes('Describe #{{ tag }} from {{ notes }}')).toBe(true);
    expect(promptHasNotes('Describe #{{tag}}')).toBe(false);
  });
});

describe('tagPromptValues', () => {
  it('lists the notes carrying the tag or one nested under it, newest first as given', () => {
    const values = tagPromptValues(
      input([
        note('Beds', ['garden'], { text: 'Raised   beds\nfor tomatoes' }),
        note('Phone', ['android']),
        note('Seeds', ['garden/seeds', 'shopping'], { description: 'What to sow in spring.' }),
        note('', ['garden']),
        note('Gardening', ['gardening']),
      ]),
    );
    expect(values.count).toBe('3');
    expect(values.notes).toBe(
      ['- Beds: Raised beds for tomatoes', '- Seeds: What to sow in spring.', '- Untitled'].join(
        '\n',
      ),
    );
    expect(values.tag).toBe('garden');
    expect(values.notebook).toBe('Personal');
    expect(values.date).toBe('2026-11-24');
    expect(values.description).toBe('');
  });

  it('prefers a note’s description to its text, and cuts each to a line', () => {
    const long = 'word '.repeat(100);
    const values = tagPromptValues(
      input([
        note('A', ['garden'], { description: 'Described.', text: 'Text.' }),
        note('B', ['garden'], { description: '  ', text: long }),
      ]),
    );
    const [a, b] = values.notes.split('\n');
    expect(a).toBe('- A: Described.');
    expect(b!.startsWith('- B: word word')).toBe(true);
    expect(b!.endsWith('…')).toBe(true);
    expect(b!.length).toBe('- B: '.length + TAG_NOTE_CHARS + 1);
  });

  it('counts the other tags on those notes, most used first, without the tag itself', () => {
    const values = tagPromptValues(
      input([
        note('1', ['garden', 'summer', 'outdoors']),
        note('2', ['garden', 'outdoors', 'outdoors']),
        note('3', ['garden/seeds', 'outdoors']),
        note('4', ['android', 'summer']),
      ]),
    );
    expect(values.tags).toBe('#outdoors (3), #garden/seeds (1), #summer (1)');
    expect(tagPromptValues(input([note('1', ['garden'])])).tags).toBe('none');
  });

  it('names at most TAG_PROMPT_MAX_TAGS other tags and says how many more', () => {
    const many = Array.from(
      { length: TAG_PROMPT_MAX_TAGS + 5 },
      (_, i) => `t${String(i).padStart(3, '0')}`,
    );
    const values = tagPromptValues(input([note('1', ['garden', ...many])]));
    expect(values.tags.split(', #')).toHaveLength(TAG_PROMPT_MAX_TAGS);
    expect(values.tags.endsWith(', and 5 more')).toBe(true);
  });

  it('keeps to the token budget and the most notes, saying how many were left out', () => {
    const notes = Array.from({ length: TAG_PROMPT_MAX_NOTES + 20 }, (_, i) =>
      note(`Note ${i}`, ['garden'], { text: 'x'.repeat(200) }),
    );
    const all = tagPromptValues(input(notes)).notes.split('\n');
    expect(all).toHaveLength(TAG_PROMPT_MAX_NOTES + 1);
    expect(all.at(-1)).toBe('- … and 20 more notes');
    // About 1,000 characters: five lines of about 175 fit.
    const tight = tagPromptValues(input(notes, { tokenLimit: 250 })).notes.split('\n');
    expect(tight.slice(0, -1).join('\n').length).toBeLessThanOrEqual(1000);
    expect(tight.length).toBeGreaterThan(2);
    expect(tight.at(-1)).toBe(`- … and ${notes.length - (tight.length - 1)} more notes`);
    // One note always goes, however small the budget.
    expect(tagPromptValues(input(notes.slice(0, 2), { tokenLimit: 1 })).notes).toBe(
      `- Note 0: ${'x'.repeat(TAG_NOTE_CHARS)}…\n- … and 1 more note`,
    );
  });

  it('says so when no note carries it, and gives the description it has', () => {
    const values = tagPromptValues(input([], { description: '  Old words. ' }));
    expect(values.count).toBe('0');
    expect(values.notes).toBe('No notes carry it now.');
    expect(values.description).toBe('Old words.');
  });
});

describe('renderTagPrompt and tagPrompt', () => {
  it('fills each token, spaces allowed, and leaves unknown ones as typed', () => {
    const values = tagPromptValues(input([note('Beds', ['garden', 'summer'])]));
    expect(
      renderTagPrompt(
        '#{{tag}} in {{ notebook }} ({{count}}) on {{date}}: {{tags}} | {{description}} | {{title}}\n{{notes}}',
        values,
      ),
    ).toBe('#garden in Personal (1) on 2026-11-24: #summer (1) |  | {{title}}\n- Beds');
  });

  it('renders the default prompt for a tag', () => {
    const text = tagPrompt(
      DEFAULT_TAG_PROMPT,
      input([note('Beds', ['garden', 'summer'], { text: 'Raised beds' })]),
    );
    expect(text).toContain('Tag: #garden\n');
    expect(text).toContain('Notebook: Personal\n');
    expect(text).toContain('Notes with it: 1\n');
    expect(text).toContain('Other tags on these notes: #summer (1)\n');
    expect(text.endsWith('- Beds: Raised beds')).toBe(true);
    expect(text).not.toMatch(/\{\{/);
  });
});

describe('tagsToDescribe', () => {
  const notes = [['project/penmoss', 'garden'], ['project/penmoss/android'], ['reading']];

  it('is every tag and level the notes carry, without the described ones', () => {
    expect(tagsToDescribe(notes, {}, false)).toEqual([
      'garden',
      'project',
      'project/penmoss',
      'project/penmoss/android',
      'reading',
    ]);
    expect(tagsToDescribe(notes, { garden: 'Beds.', project: '  ', gone: 'x' }, false)).toEqual([
      'project',
      'project/penmoss',
      'project/penmoss/android',
      'reading',
    ]);
  });

  it('replaces the described ones too when asked', () => {
    expect(tagsToDescribe(notes, { garden: 'Beds.' }, true)).toHaveLength(5);
  });
});

describe('the words the Mac and Android share (A1677)', () => {
  it('says how many tags Generate All sends, and that each goes to the AI provider', () => {
    expect(generateAllTagsWords(0, false)).toBe('Every tag has a description already.');
    expect(generateAllTagsWords(0, true)).toBe('There are no tags to describe.');
    expect(generateAllTagsWords(1, false)).toBe(
      '1 tag has no description. Each goes to your AI provider with its notes’ titles and descriptions, two at a time.',
    );
    expect(generateAllTagsWords(2, false)).toBe(
      '2 tags have no description. Each goes to your AI provider with its notes’ titles and descriptions, two at a time.',
    );
    expect(generateAllTagsWords(1, true)).toBe(
      '1 tag will be described, replacing any description they have. Each goes to your AI provider with its notes’ titles and descriptions, two at a time.',
    );
    expect(generateAllTagsWords(3, true)).toBe(
      '3 tags will be described, replacing any description they have. Each goes to your AI provider with its notes’ titles and descriptions, two at a time.',
    );
  });

  it('names the token each prompt cannot do without', () => {
    expect(AI_DESCRIPTION_COPY['tagPrompt.missing']).toContain('{{notes}}');
    expect(AI_DESCRIPTION_COPY['notePrompt.missing']).toContain('{{body}}');
  });
});
