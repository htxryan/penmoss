import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError, type FlagSpec } from '../src/args';

const FLAGS: readonly FlagSpec[] = [
  { name: 'json', type: 'boolean', description: 'JSON' },
  { name: 'help', short: 'h', type: 'boolean', description: 'Help' },
  { name: 'tag', short: 't', type: 'list', value: 'tag', description: 'A tag' },
  { name: 'section', type: 'string', value: 'heading', description: 'A heading' },
  { name: 'limit', type: 'integer', value: 'n', description: 'How many' },
];

describe('parseArgs', () => {
  it('reads positionals, booleans, strings, repeated lists and integers in any order', () => {
    const parsed = parseArgs(
      ['Garden', '--json', '--tag', 'a', '-t', 'b', '--section=## Plans', '--limit', '5', '-'],
      FLAGS,
    );
    expect(parsed.positionals).toEqual(['Garden', '-']);
    expect(parsed.flags).toEqual({
      json: true,
      tag: ['a', 'b'],
      section: '## Plans',
      limit: 5,
    });
  });

  it('takes the next word as a value even when it starts with a dash, unless it is an option', () => {
    expect(parseArgs(['--section', '-'], FLAGS).flags['section']).toBe('-');
    expect(parseArgs(['--section', '-x'], FLAGS).flags['section']).toBe('-x');
    expect(parseArgs(['--section', '--nope'], FLAGS).flags['section']).toBe('--nope');
    // A word that is one of the command's options is never swallowed as a value (A173).
    for (const next of ['--json', '-h', '--tag', '--limit=3', '-t']) {
      expect(() => parseArgs(['--section', next], FLAGS)).toThrow(
        /--section needs a value \(to pass one that looks like an option, write --section=/,
      );
    }
    expect(parseArgs(['--section=--json'], FLAGS).flags['section']).toBe('--json');
  });

  it('says which options it read before a usage error', () => {
    const error = (() => {
      try {
        parseArgs(['--json', '--section'], FLAGS);
      } catch (caught) {
        return caught as UsageError;
      }
      return null;
    })();
    expect(error?.flags).toEqual({ json: true });
  });

  it('treats everything after -- as positionals', () => {
    expect(parseArgs(['--', '--json', '-h'], FLAGS)).toEqual({
      positionals: ['--json', '-h'],
      flags: {},
    });
  });

  it('refuses unknown options, missing values, values on booleans and bad integers', () => {
    const cases: Array<[string[], RegExp]> = [
      [['--nope'], /unknown option --nope/],
      [['-x'], /unknown option -x/],
      [['--section'], /--section needs a value/],
      [['--json=yes'], /--json takes no value/],
      [['--limit', 'many'], /--limit must be a whole number/],
      [['--limit', '0'], /--limit must be a whole number/],
      [['--section', 'a', '--section', 'b'], /--section given twice/],
    ];
    for (const [argv, message] of cases) {
      expect(() => parseArgs(argv, FLAGS)).toThrow(UsageError);
      expect(() => parseArgs(argv, FLAGS)).toThrow(message);
    }
  });
});
