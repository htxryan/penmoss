/**
 * `@penmoss/git-notebook` (T50 G1, #149): a notebook that syncs only through a git repository.
 * The layout and writer logs (A821), the sync engine over a `GitTransport` (A822), deterministic
 * rendering with stored names (A823) and Delete for good (A828). Platform-free: system git for
 * Node is in `@penmoss/git-notebook/node`, the local notes API in `@penmoss/git-notebook/local`.
 */
export * from './actors';
export * from './agent-activity';
export * from './engine';
export * from './history';
export * from './layout';
export * from './memory';
export * from './names';
export * from './purge';
export * from './render';
export * from './replica';
export * from './transport';
export * from './identity';
export * from './writer';
export {
  ENGINE_ORIGIN,
  GIT_ORIGIN,
  isUpdate,
  LOCAL_STORE_ORIGIN,
  mergeUpdates,
  ownFile,
  sameBytes,
  sameContent,
} from './yjs';
export * from './ops';
export * from './timeline';
