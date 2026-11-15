/**
 * The engine and actor types that records and comments name. (The NoteDoc WebSocket protocol
 * these came from went with the server, D49.)
 */

/**
 * The Yjs stack a note is written with (D31: Yjs 14). It is fixed per note and stored with its
 * record, so a future engine change can tell old notes apart.
 */
export type EngineName = 'yjs14';

export type ActorKind = 'device' | 'agent';

export interface Actor {
  readonly id: string;
  readonly kind: ActorKind;
  readonly label: string;
}
