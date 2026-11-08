/**
 * `@penmoss/git-notebook/system-git` (T50 Mac lane, A853): the system-git transport, reading
 * remotes and git's process handling alone, without the engine or Yjs. What the Mac
 * app's main process runs: the page runs the engine and asks main for git over IPC (#151).
 */
export * from './git';
export * from './transport';
export * from './remote';
export {
  GitTransportError,
  type CommitInfo,
  type GitErrorCode,
  type PushOutcome,
} from '../transport';
