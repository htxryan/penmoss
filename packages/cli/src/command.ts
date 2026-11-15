/**
 * What every command gets: its parsed arguments, the git notebook it runs on (its notes API,
 * `LocalNotebook`, under the clone's lock), and output that is human-readable by default and one
 * JSON document with `--json`.
 */
import type { LocalNotebook } from '@penmoss/git-notebook/local';
import { UsageError, type FlagSpec, type FlagValue } from './args';
import { apiErrorOf } from './errors';
import type { Io, NotebookSession } from './io';

export interface Command {
  readonly name: string;
  /** One line for `penmoss --help`. */
  readonly summary: string;
  /** The usage lines after `penmoss `. */
  readonly usage: readonly string[];
  /** Paragraphs for `penmoss <command> --help`. */
  readonly description: readonly string[];
  readonly flags: readonly FlagSpec[];
  readonly examples?: readonly string[];
  run(context: Context): Promise<void>;
}

export class Context {
  constructor(
    readonly io: Io,
    readonly positionals: readonly string[],
    readonly flags: Readonly<Record<string, FlagValue>>,
    /** The git notebook a note command runs on (`--notebook`, or the only one, A1050). */
    readonly session: NotebookSession | null = null,
  ) {}

  get json(): boolean {
    return this.flags['json'] === true;
  }

  /** ANSI styling: only on a terminal, and never with NO_COLOR. */
  get color(): boolean {
    return this.io.stdout.isTTY && !this.io.env['NO_COLOR'];
  }

  string(name: string): string | undefined {
    return this.flags[name] as string | undefined;
  }

  number(name: string): number | undefined {
    return this.flags[name] as number | undefined;
  }

  list(name: string): string[] {
    return (this.flags[name] as string[] | undefined) ?? [];
  }

  bool(name: string): boolean {
    return this.flags[name] === true;
  }

  /**
   * Reads the notebook (A820): only a note command, which runs on a notebook, has one. Its
   * refusals become `ApiError`s with their exit codes.
   */
  async read<T>(read: (notebook: LocalNotebook) => T | Promise<T>): Promise<T> {
    if (!this.session) throw new Error('this command runs on no notebook');
    try {
      return await read(this.session.notebook);
    } catch (error) {
      throw apiErrorOf(error);
    }
  }

  /**
   * Changes the notebook, as `read` reads it. The clone is saved after the change, and after a
   * refusal too, before the command goes on (B1 of #165): a command killed during the sync that
   * follows loses nothing; the next sync sends it.
   */
  async write<T>(change: (notebook: LocalNotebook) => T | Promise<T>): Promise<T> {
    if (!this.session) throw new Error('this command runs on no notebook');
    const session = this.session;
    let result: T;
    try {
      result = await change(session.notebook);
    } catch (error) {
      const refusal = apiErrorOf(error);
      if (refusal !== error) await session.save();
      throw refusal;
    }
    await session.save();
    return result;
  }

  /** Writes the result: `data` as JSON with `--json`, else the human lines. */
  emit(data: unknown, human: () => string | readonly string[]): void {
    if (this.json) {
      this.io.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      return;
    }
    const text = human();
    const lines = typeof text === 'string' ? text : text.join('\n');
    if (lines) this.io.stdout.write(lines.endsWith('\n') ? lines : `${lines}\n`);
  }

  /** A note for people on stderr (never in the way of `--json` on stdout). */
  note(text: string): void {
    this.io.stderr.write(`${text}\n`);
  }

  /** Exactly `count` positionals (or between min and max), named for the usage error. */
  args(names: readonly string[], optional = 0): string[] {
    const min = names.length - optional;
    if (this.positionals.length < min) {
      throw new UsageError(`missing ${names[this.positionals.length]}`);
    }
    if (this.positionals.length > names.length) {
      throw new UsageError(`unexpected argument “${this.positionals[names.length]}”`);
    }
    return [...this.positionals];
  }

  /**
   * Markdown to send: `-` (a positional or `stdinFlag`'s value) reads stdin,
   * `--text` gives it inline. With neither it is a usage error: stdin is never
   * read implicitly, so an open pipe never hangs a command (A167, A168).
   */
  async content(options: { readonly dash: boolean; readonly what: string }): Promise<string> {
    const text = this.string('text');
    if (options.dash && text !== undefined) {
      throw new UsageError('give the content once: either - (stdin) or --text');
    }
    if (text !== undefined) return text;
    if (options.dash) return this.io.stdin.read();
    throw new UsageError(
      `no ${options.what}: pass - to read it from stdin (e.g. echo "…" | penmoss …), or --text "…"`,
    );
  }
}
