/** Prompts from `tools/factory/prompts/*.md`, filled in by `{{name}}`. */
import { readFileSync } from 'node:fs';

export type PromptName = 'implement' | 'planning' | 'validate' | 'review';

export function promptTemplate(name: PromptName): string {
  return readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');
}

/** Fills `{{name}}` placeholders; a missing value is an error, never left in the prompt. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`prompt placeholder {{${key}}} has no value`);
    return value;
  });
}
