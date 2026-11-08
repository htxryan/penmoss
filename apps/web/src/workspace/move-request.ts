/**
 * Notes waiting for the folder picker (T42, A570): the tree's context menu asks for "Move to
 * folder…" on its selection, and the command overlays, which own the picker, open it.
 */
export class MoveRequest {
  private current: readonly string[] | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): readonly string[] | null => this.current;

  /** Asks to move `noteIds` (null: nothing asked). */
  set(noteIds: readonly string[] | null): void {
    this.current = noteIds && noteIds.length > 0 ? noteIds : null;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const moveRequest = new MoveRequest();
