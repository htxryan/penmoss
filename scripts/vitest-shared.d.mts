// Types for scripts/vitest-shared.mjs, which every package's vitest config imports.
export declare function workers(
  env?: Readonly<Record<string, string | undefined>>,
  cpus?: number,
): number;
export declare function realGitDir(
  platform?: NodeJS.Platform,
  env?: Readonly<Record<string, string | undefined>>,
): string | null;
export declare function testPath(
  env?: Readonly<Record<string, string | undefined>>,
  platform?: NodeJS.Platform,
): string;
export declare function sharedTest(files: {
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
  readonly env?: boolean;
}): {
  testTimeout: number;
  hookTimeout: number;
  include: string[];
  exclude: string[];
  maxWorkers: number;
  env?: { PATH: string };
};
