/**
 * `@penmoss/git-notebook/host` (T50 G3, G7): what a client's engine host is built on, the same on
 * the Mac and on Android. The engine's own store (`EngineStorage` over an `EngineKv`) and the
 * sync's cadence, bounds and words for a failure.
 */
export * from './engine-store';
export * from './sync';
