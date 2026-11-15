/** Why a notebook cannot sync, as opposed to how git failed (`GitTransportError`). */
export type NotebookErrorCode =
  /** The target holds no notebook and this device was not asked to make one. */
  | 'no_notebook'
  /** The target holds another notebook than the one this profile is of. */
  | 'other_notebook'
  /** `notebook.json` is newer than this client knows, or unreadable. */
  | 'format'
  /** Every attempt's push was rejected (others kept pushing). */
  | 'busy'
  /** The branch was synced before and is gone now: never recreated as a new history (A822). */
  | 'branch_gone'
  /** Even a new writer's actor file would pass `MAX_ACTOR_BYTES` (a writer retires before). */
  | 'actor_full'
  /** A copy brought back after a store was cleared would land without its own log (A886). */
  | 'copy_unwritten';

export class NotebookError extends Error {
  constructor(
    readonly code: NotebookErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NotebookError';
  }
}

/** A writer's actor file is full: the sync retires it and goes on (internal, A850). */
export class WriterFull extends Error {
  constructor(readonly carry: readonly number[]) {
    super("The writer's actor file is full");
  }
}
