/**
 * Title Case as Penmoss writes it (A938 as amended by PEN-137): the plan's examples, and the
 * edges the Settings, confirmation and analytics checks lean on.
 */
import { describe, expect, it } from 'vitest';
import { isTitleCase, SHORT_WORDS, titleCase, titleCaseProblem } from '../src/title-case';

/** The plan's examples (T12 inventory, Copy and Title Case): each is already right. */
const EXAMPLES = [
  'Move to Folder',
  'Search by Meaning',
  'Show in the Sidebar',
  'Keep at Most',
  'Attach Logs from the Last',
  'Sign In with GitHub',
  'Claude Code: Run in a Terminal',
  'Run the CLI As',
  'Raised (Menus, Cards, Dialogs)',
  'Note, Info, To-Do',
  'System Sans-Serif',
  'Delete “X” for Good?',
  'Send To…',
  'penmoss Command Installed',
  'Codex: Add to ~/.codex/config.toml',
  'Share How You Use Penmoss?',
  'Delete Your Shared Data?',
  'Reset My Analytics ID',
  'Waiting for Your Answer',
  'Delete {count} Events?',
  'Don’t Share',
  'Shortcut from Any App',
  'Nothing Waits to Be Pushed',
  'Signed In with GitHub',
  'Use the Compact Title Bar?',
];

/** What the T12 sweep changes: the old text, then what titleCase() makes of it. */
const SWEEP: ReadonlyArray<readonly [string, string]> = [
  ['Move to folder', 'Move to Folder'],
  ['Raised (menus, cards, dialogs)', 'Raised (Menus, Cards, Dialogs)'],
  ['Note, info, to-do', 'Note, Info, To-Do'],
  ['System sans-serif', 'System Sans-Serif'],
  ['Delete “X” for good?', 'Delete “X” for Good?'],
  ['Send to…', 'Send To…'],
  ['penmoss command installed', 'penmoss Command Installed'],
  ['Codex: add to ~/.codex/config.toml', 'Codex: Add to ~/.codex/config.toml'],
  ['Claude Code: run in a terminal', 'Claude Code: Run in a Terminal'],
  ['Run the CLI as', 'Run the CLI As'],
  ['Signed in with GitHub', 'Signed In with GitHub'],
  ['Shortcut From Any App', 'Shortcut from Any App'],
  ['Pictures From the Web', 'Pictures from the Web'],
  ['Discard this draft?', 'Discard This Draft?'],
  ['the end of the line', 'The End of the Line'],
  ['Not synced yet', 'Not Synced Yet'],
  ['Hue and saturation', 'Hue and Saturation'],
  ['Turn off sharing', 'Turn Off Sharing'],
  ['Log in to GitHub', 'Log In to GitHub'],
  ['Back up on the phone', 'Back Up on the Phone'],
];

describe('titleCase', () => {
  it.each(EXAMPLES)('keeps “%s” as it is', (text) => {
    expect(titleCase(text)).toBe(text);
    expect(isTitleCase(text)).toBe(true);
    expect(titleCaseProblem(text)).toBeNull();
  });

  it.each(SWEEP)('makes “%s” into “%s”', (before, after) => {
    expect(titleCase(before)).toBe(after);
    expect(isTitleCase(before)).toBe(false);
    expect(titleCase(after)).toBe(after);
  });

  it('keeps short words lower case only in the middle', () => {
    for (const word of SHORT_WORDS) {
      expect(titleCase(`${word} x ${word} y ${word}`)).toBe(
        `${word[0]!.toUpperCase()}${word.slice(1)} X ${word} Y ${word[0]!.toUpperCase()}${word.slice(1)}`,
      );
    }
  });

  it('capitalises a short word after a colon or a dash', () => {
    expect(titleCase('Agents: the list')).toBe('Agents: The List');
    expect(titleCase('Logs — of today')).toBe('Logs — Of Today');
  });

  it('keeps words written their own way', () => {
    for (const text of ['Open in macOS', 'Use npm and pnpm', 'Press ⌘K', 'Set {device} Name']) {
      expect(isTitleCase(text)).toBe(true);
    }
    expect(titleCase('connect with MCP')).toBe('Connect with MCP');
    expect(titleCase('edit config.toml')).toBe('Edit config.toml');
  });

  it('keeps the spacing as it was', () => {
    expect(titleCase('  move   to folder ')).toBe('  Move   to Folder ');
    expect(titleCase('')).toBe('');
  });
});

describe('titleCaseProblem', () => {
  it('names the first word that breaks the rule', () => {
    expect(titleCaseProblem('Move To folder')).toBe('"To" should be "to" in "Move To folder"');
  });
});
