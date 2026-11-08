/**
 * The command line, parsed against each command's flags. Options may come
 * anywhere among the positionals; `--name value` and `--name=value` both
 * work; a string option takes the next word, even one starting with a dash
 * (so `--append -` reads stdin and `--with -x` replaces with "-x"), unless
 * that word is one of the command's own options (A173): `--text --json` is
 * a missing value, never the text "--json" (write `--text=--json` for
 * that). `--` ends the options; `-` alone is a positional (stdin).
 */

export type FlagType = 'boolean' | 'string' | 'list' | 'integer';

export interface FlagSpec {
  /** The long name, without `--`. */
  readonly name: string;
  /** A one-letter alias, without `-`. */
  readonly short?: string;
  readonly type: FlagType;
  /** The value's placeholder in help, e.g. `heading`. */
  readonly value?: string;
  readonly description: string;
}

export type FlagValue = boolean | string | string[] | number;

export interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Record<string, FlagValue>;
}

/** The command line does not fit the command (exit 2). */
export class UsageError extends Error {
  /** The options read before the error, when it came from parsing (so `--json` still counts). */
  flags?: Readonly<Record<string, FlagValue>>;
}

export function parseArgs(argv: readonly string[], specs: readonly FlagSpec[]): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  try {
    return { positionals: parseInto(argv, specs, flags), flags };
  } catch (error) {
    if (error instanceof UsageError) error.flags = { ...flags };
    throw error;
  }
}

/** Whether `word` names one of `specs` (`--name`, `--name=…`, `-x`). */
function isOption(word: string, specs: readonly FlagSpec[]): boolean {
  if (word.startsWith('--')) {
    const eq = word.indexOf('=');
    const name = word.slice(2, eq < 0 ? undefined : eq);
    return specs.some((spec) => spec.name === name);
  }
  return (
    word.length > 1 && word.startsWith('-') && specs.some((spec) => spec.short === word.slice(1))
  );
}

function parseInto(
  argv: readonly string[],
  specs: readonly FlagSpec[],
  flags: Record<string, FlagValue>,
): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (word === '-' || !word.startsWith('-')) {
      positionals.push(word);
      continue;
    }
    const long = word.startsWith('--');
    const eq = long ? word.indexOf('=') : -1;
    const name = long ? word.slice(2, eq < 0 ? undefined : eq) : word.slice(1);
    const spec = specs.find((each) => (long ? each.name === name : each.short === name));
    if (!spec) throw new UsageError(`unknown option ${long ? '--' : '-'}${name}`);
    const label = `--${spec.name}`;
    if (spec.type === 'boolean') {
      if (eq >= 0) throw new UsageError(`${label} takes no value`);
      flags[spec.name] = true;
      continue;
    }
    let value: string;
    if (eq >= 0) {
      value = word.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`${label} needs a value`);
      if (isOption(next, specs)) {
        throw new UsageError(
          `${label} needs a value (to pass one that looks like an option, write ${label}=${next})`,
        );
      }
      value = next;
      i++;
    }
    if (spec.type === 'list') {
      const list = (flags[spec.name] as string[] | undefined) ?? [];
      list.push(value);
      flags[spec.name] = list;
      continue;
    }
    if (flags[spec.name] !== undefined) throw new UsageError(`${label} given twice`);
    if (spec.type === 'integer') {
      const number = /^\d+$/.test(value) ? Number(value) : NaN;
      if (!Number.isSafeInteger(number) || number < 1) {
        throw new UsageError(`${label} must be a whole number above 0`);
      }
      flags[spec.name] = number;
    } else {
      flags[spec.name] = value;
    }
  }
  return positionals;
}
