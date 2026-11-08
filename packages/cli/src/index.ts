/**
 * The penmoss CLI as a library (T26): `run(argv, io)` with everything it touches passed in.
 * `bin.ts` runs it in Node (`node.ts` has the Node pieces the Mac app uses).
 */
export { run, COMMANDS } from './main';
export { memoryTokenStore } from './memory-store';
export { EXIT, type ExitCode } from './errors';
export type { FetchLike, FetchResponse, Io, StdioIo, TokenLocation, TokenStore } from './io';
