/**
 * The CLI in Node, for the Mac app (T54, A992, A993): the app runs `run` in its own binary
 * (`Penmoss --penmoss-cli …`) and makes an agent's clone of a git notebook with `nodeNotebooks`,
 * as `penmoss notebook add --agent` does, in the same `~/.penmoss`.
 */
export { killGitOnSignals } from '@penmoss/git-notebook/node';
export { run } from './main';
export { nodeIo } from './node-io';
export { nodeNotebooks, type NodeNotebooksOptions } from './node-notebooks';
export type { NotebookEntry, NotebookIo } from './io';
export { CliError } from './errors';
