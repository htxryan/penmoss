/**
 * T20 acceptance: "a test enumerates every UI action and fails if one lacks a
 * command". It reads every component's source and finds each button and each
 * link with a click handler. Each must name a registered command
 * (`data-command`, run through the registry) or say what it is with
 * `data-ui`: a step inside a flow some command started (`submit`,
 * `dismiss`), an action on one listed item (`item`), an option of a menu or
 * list (`option`, `menu`). The editor's toolbar has the same check in
 * packages/editor/test/editor-commands.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/commands/definitions';

const SOURCE = fileURLToPath(new URL('../../src', import.meta.url));
const UI_KINDS = new Set(['submit', 'dismiss', 'item', 'option', 'menu']);

function components(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return components(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/** Opening tags of buttons, and of links that handle clicks. */
function actions(source: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(/<(button|a)\b/g)) {
    // The tag runs to the first `>` outside braces (JSX expressions can hold `=>`).
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < source.length; end++) {
      const char = source[end];
      if (char === '{') depth++;
      else if (char === '}') depth--;
      else if (char === '>' && depth === 0) break;
    }
    const tag = source.slice(match.index, end + 1);
    if (match[1] === 'a' && !/\bonClick=/.test(tag)) continue;
    tags.push(tag.replace(/\s+/g, ' '));
  }
  return tags;
}

describe('every UI action is a command (T20, FR-NAV-1)', () => {
  const ids = new Set(COMMANDS.map((command) => command.id));
  const files = components(SOURCE);

  it('finds the components', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('marks every button and clickable link with a command or a kind', () => {
    const unmarked: string[] = [];
    const unknown: string[] = [];
    let count = 0;
    for (const file of files) {
      for (const tag of actions(readFileSync(file, 'utf8'))) {
        count++;
        const command = /data-command="([^"]+)"/.exec(tag)?.[1];
        const dynamic = /data-command=\{/.test(tag);
        const kind = /data-ui="([^"]+)"/.exec(tag)?.[1];
        const where = `${file.slice(SOURCE.length + 1)}: ${tag.slice(0, 90)}`;
        if (command) {
          if (!ids.has(command)) unknown.push(`${where} (${command})`);
        } else if (!dynamic && !(kind && UI_KINDS.has(kind))) {
          unmarked.push(where);
        }
      }
    }
    expect(count).toBeGreaterThan(20);
    expect(unmarked).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('runs marked buttons through the registry', () => {
    // A button naming a command calls commands.run (directly) for that command.
    const skipped: string[] = [];
    for (const file of files) {
      for (const tag of actions(readFileSync(file, 'utf8'))) {
        const command = /data-command="([^"]+)"/.exec(tag)?.[1];
        if (!command || /linkHandler|onCustomise|setDraft|setDeleting|askDelete/.test(tag))
          continue;
        if (!tag.includes(`commands.run('${command}'`)) skipped.push(`${file}: ${command}`);
      }
    }
    expect(skipped).toEqual([]);
  });
});
