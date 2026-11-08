/**
 * New note runs once per gesture (T39). A double click on the button, a
 * double tap on the phone's floating button or a held shortcut ran it twice
 * or more, leaving empty "Untitled" notes behind. Within this long of the
 * last one, while that note is still the one open and still has no title,
 * New note does nothing. Once it has a title, another note was meant.
 */
export const NEW_NOTE_REPEAT_MS = 1000;

export interface LastCreated {
  readonly id: string;
  readonly at: number;
}

/** The note open now, with its title as typed so far. */
export interface OpenNoteTitle {
  readonly id: string;
  readonly title: string;
}

/** Whether New note now repeats the one that made `last`. */
export function isRepeatedNewNote(
  last: LastCreated | null,
  open: OpenNoteTitle | null,
  now: number,
): boolean {
  return (
    last !== null &&
    open !== null &&
    last.id === open.id &&
    open.title.trim() === '' &&
    now - last.at < NEW_NOTE_REPEAT_MS
  );
}

/**
 * Whether a run of New note comes from a held shortcut's repeated keydown
 * (`repeat`). New note acts on the first press only: the window above counts
 * from the note's creation, so a key held longer made another note every
 * second (T39 review, A378). The repeats are still taken, so they type nothing.
 */
export function isKeyRepeat(context: { readonly event?: { readonly repeat: boolean } }): boolean {
  return context.event?.repeat === true;
}
