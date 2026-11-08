/**
 * A change kept as a page went carries whether the page's copy had had the server's state
 * (`seeded`, A810), and merging it keeps that (T50 G1, the nit left by #141): a record first
 * stored by such an entry, or merged with one, says it is seeded, whichever of the two had it.
 */
import { describe, expect, it } from 'vitest';
import type { UnloadWrite } from '../src/record';
import { recordFromDoc } from '../src/records';
import { decodeUnloadWrite, encodeUnloadWrite, withUnloadWrite } from '../src/unload';
import { appendParagraph, createReplica } from './support/editing';

function written(paragraphs: string[]) {
  const replica = createReplica();
  for (const text of paragraphs) appendParagraph(replica, text);
  return replica;
}

function kept(
  replica: ReturnType<typeof createReplica>,
  since: Uint8Array | null,
  extra: Partial<UnloadWrite> = {},
): UnloadWrite {
  return {
    noteId: 'n1',
    engine: 'yjs14',
    source: 'editor',
    epoch: 'e1',
    update: since ? replica.encodeStateAsUpdate(since) : replica.encodeStateAsUpdate(),
    whole: since === null,
    unsynced: true,
    updatedAt: 1_700_000_000_000,
    ...extra,
  };
}

describe('withUnloadWrite keeps the seeded flag', () => {
  it('makes a note never stored seeded when the page had the server state', () => {
    const replica = written(['typed after the server state arrived']);
    const { records, outcome } = withUnloadWrite(undefined, kept(replica, null, { seeded: true }));
    expect(outcome).toBe('merged');
    expect(records[0]?.seeded).toBe(true);
  });

  it('leaves a note never stored unseeded when the page had not', () => {
    const replica = written(['typed offline']);
    const { records } = withUnloadWrite(undefined, kept(replica, null));
    expect(records[0]?.seeded).toBeUndefined();
  });

  it('marks an unseeded record seeded when a seeded page merges into it', () => {
    const replica = written(['first']);
    const stored = recordFromDoc('n1', replica.doc, { epoch: 'e1', unsynced: false });
    expect(stored.seeded).toBeUndefined();
    appendParagraph(replica, 'last words');
    const { records, outcome } = withUnloadWrite(
      stored,
      kept(replica, stored.stateVector, { seeded: true }),
    );
    expect(outcome).toBe('merged');
    expect(records[0]?.text).toBe('first\nlast words');
    expect(records[0]?.seeded).toBe(true);
  });

  it('keeps a seeded record seeded when an unseeded page merges into it', () => {
    const replica = written(['first']);
    const stored = recordFromDoc('n1', replica.doc, { epoch: 'e1', unsynced: false, seeded: true });
    appendParagraph(replica, 'more');
    const { records } = withUnloadWrite(stored, kept(replica, stored.stateVector));
    expect(records[0]?.seeded).toBe(true);
  });

  it('keeps the flag through local storage', () => {
    const replica = written(['x']);
    const write = kept(replica, null, { seeded: true });
    expect(decodeUnloadWrite(encodeUnloadWrite(write))?.seeded).toBe(true);
    expect(decodeUnloadWrite(encodeUnloadWrite(kept(replica, null)))?.seeded).toBeUndefined();
  });
});
