import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import * as syncProtocol from '@y/protocols/sync';
import * as Y from '@y/y';
import { decodeMessage, encodeMessage } from '../src/protocol';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('sync protocol codec (what the personal export reads, A1039)', () => {
  it('round-trips sync step 1 and step 2', () => {
    const messages = [
      { type: 'sync-step1', stateVector: bytes(1, 2) },
      { type: 'sync-step2', update: bytes(3, 4, 5) },
    ] as const;
    for (const message of messages) {
      expect(decodeMessage(encodeMessage(message))).toEqual(message);
    }
  });

  it('reports any other message as unknown instead of throwing', () => {
    const other = encoding.createEncoder();
    encoding.writeVarUint(other, 100);
    encoding.writeVarString(other, JSON.stringify({ epoch: 'e1' }));
    expect(decodeMessage(encoding.toUint8Array(other))).toEqual({ type: 'unknown', code: 100 });
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, 0);
    encoding.writeVarUint(update, 2);
    encoding.writeVarUint8Array(update, bytes(6));
    expect(decodeMessage(encoding.toUint8Array(update))).toEqual({ type: 'unknown', code: 0 });
  });

  it('is wire-compatible with @y/protocols sync messages', () => {
    const doc = new Y.Doc();
    doc.get('t').insert(0, 'hello');

    // @y/protocols writes step 1; our decoder reads it.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // messageSync
    syncProtocol.writeSyncStep1(encoder, doc);
    const decoded = decodeMessage(encoding.toUint8Array(encoder));
    expect(decoded).toEqual({ type: 'sync-step1', stateVector: Y.encodeStateVector(doc) });

    // Our encoder writes step 2; @y/protocols applies it.
    const message = encodeMessage({ type: 'sync-step2', update: Y.encodeStateAsUpdate(doc) });
    const decoder = decoding.createDecoder(message);
    expect(decoding.readVarUint(decoder)).toBe(0);
    const remote = new Y.Doc();
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), remote, 'test');
    expect(remote.get('t').toString()).toBe('hello');
  });
});
