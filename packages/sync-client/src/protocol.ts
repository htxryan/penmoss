/**
 * What is left of the NoteDoc WebSocket protocol since T59 (D49, A1039): the engine and actor
 * types records and comments still name, and the y-protocols sync messages (type 0) that the
 * personal-workspace export reads the server's WorkspaceDoc with (git-notebook's personal.ts).
 * Every other message, and the provider that spoke them, went with the server.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

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

export type Message =
  | { readonly type: 'sync-step1'; readonly stateVector: Uint8Array }
  | { readonly type: 'sync-step2'; readonly update: Uint8Array }
  | { readonly type: 'unknown'; readonly code: number };

const MESSAGE_SYNC = 0;
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;

export function encodeMessage(message: Exclude<Message, { type: 'unknown' }>): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  if (message.type === 'sync-step1') {
    encoding.writeVarUint(encoder, SYNC_STEP1);
    encoding.writeVarUint8Array(encoder, message.stateVector);
  } else {
    encoding.writeVarUint(encoder, SYNC_STEP2);
    encoding.writeVarUint8Array(encoder, message.update);
  }
  return encoding.toUint8Array(encoder);
}

/** Throws on malformed input; any message but sync step 1 or 2 is `unknown`. */
export function decodeMessage(data: Uint8Array): Message {
  const decoder = decoding.createDecoder(data);
  const code = decoding.readVarUint(decoder);
  if (code !== MESSAGE_SYNC) return { type: 'unknown', code };
  const step = decoding.readVarUint(decoder);
  const payload = decoding.readVarUint8Array(decoder);
  if (step === SYNC_STEP1) return { type: 'sync-step1', stateVector: payload };
  if (step === SYNC_STEP2) return { type: 'sync-step2', update: payload };
  return { type: 'unknown', code };
}
