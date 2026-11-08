/**
 * A thin wrapper over the `gh` CLI. The factory talks to GitHub only through `gh`. As the
 * publisher it runs with the GitHub App's installation token (A1222), fetched for every call so
 * an hour-long token never goes stale mid-run; `factory next` and the UI use Ryan's own login.
 */
import type { Exec } from './exec.ts';

export class GhError extends Error {
  readonly args: readonly string[];
  readonly code: number;
  readonly stderr: string;

  constructor(args: readonly string[], code: number, stderr: string) {
    super(
      `gh ${args.slice(0, 3).join(' ')} failed (exit ${code}): ${stderr.trim().split('\n').slice(-1)[0] ?? ''}`,
    );
    this.name = 'GhError';
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

export type GraphQLValue = string | number | boolean;

export interface Gh {
  /** Runs `gh <args>` and returns its stdout; a non-zero exit throws `GhError`. */
  run(args: readonly string[], input?: string): Promise<string>;
  /** Runs `gh <args>` and parses stdout as JSON. */
  json<T>(args: readonly string[]): Promise<T>;
  /** One GraphQL request through `gh api graphql`; absent variables are left out. */
  graphql<T>(
    query: string,
    variables?: Readonly<Record<string, GraphQLValue | undefined>>,
  ): Promise<T>;
}

export interface GhOptions {
  readonly exec: Exec;
  /** The environment `gh` runs with. */
  readonly env?: Readonly<Record<string, string>>;
  /** A token for every call, as `GH_TOKEN`: the publisher's installation token. */
  readonly token?: () => Promise<string>;
  readonly bin?: string;
}

export function createGh({ exec, env, token, bin = 'gh' }: GhOptions): Gh {
  const run = async (args: readonly string[], input?: string): Promise<string> => {
    const withToken = token ? { ...env, GH_TOKEN: await token() } : env;
    const result = await exec(bin, args, {
      ...(withToken ? { env: withToken } : {}),
      ...(input === undefined ? {} : { input }),
    });
    if (result.code !== 0) throw new GhError(args, result.code, result.stderr);
    return result.stdout;
  };
  const json = async <T>(args: readonly string[]): Promise<T> => JSON.parse(await run(args)) as T;
  const graphql = async <T>(
    query: string,
    variables: Readonly<Record<string, GraphQLValue | undefined>> = {},
  ): Promise<T> => {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [name, value] of Object.entries(variables)) {
      if (value === undefined) continue;
      // -f sends a string; -F lets gh type numbers and booleans.
      args.push(typeof value === 'string' ? '-f' : '-F', `${name}=${String(value)}`);
    }
    const body = await json<{ data?: T; errors?: { message: string }[] }>(args);
    if (body.errors?.length)
      throw new GhError(args, 0, body.errors.map((e) => e.message).join('; '));
    if (body.data === undefined) throw new GhError(args, 0, 'GraphQL response had no data');
    return body.data;
  };
  return { run, json, graphql };
}
