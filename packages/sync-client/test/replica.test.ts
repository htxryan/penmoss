import { describe, expect, it } from 'vitest';
import { sameRanges, type Replica } from '../src/replica';
import { appendParagraph, createReplica, deleteText, insertText } from './support/editing';

describe('Yjs 14 replica', () => {
  function exchange(a: Replica, b: Replica) {
    b.applyUpdate(a.encodeStateAsUpdate(b.encodeStateVector()), 'remote');
    a.applyUpdate(b.encodeStateAsUpdate(a.encodeStateVector()), 'remote');
  }

  it('converges after interleaved offline edits on two replicas', () => {
    const a = createReplica();
    const b = createReplica();
    appendParagraph(a, 'shared');
    exchange(a, b);

    // Both edit the same paragraph while disconnected, interleaving local edits.
    insertText(a, 0, 0, 'A1 ');
    insertText(b, 0, 6, ' B1');
    appendParagraph(a, 'from A');
    insertText(b, 0, 0, 'B2 ');
    appendParagraph(b, 'from B');
    exchange(a, b);

    expect(a.plainText()).toBe(b.plainText());
    expect(a.encodeStateVector()).toEqual(b.encodeStateVector());
    for (const fragment of ['A1 ', ' B1', 'B2 ', 'shared', 'from A', 'from B']) {
      expect(a.plainText()).toContain(fragment);
    }
  });

  it('reports local and remote updates with their origin', () => {
    const a = createReplica();
    const b = createReplica();
    const seen: unknown[] = [];
    const off = b.onUpdate((update, origin) => {
      expect(update.byteLength).toBeGreaterThan(0);
      seen.push(origin);
    });
    appendParagraph(a, 'x');
    b.applyUpdate(a.encodeStateAsUpdate(), 'remote');
    appendParagraph(b, 'y');
    off();
    appendParagraph(b, 'z');
    expect(seen).toEqual(['remote', null]);
  });

  it('decodes state vectors into client clocks', () => {
    const a = createReplica();
    appendParagraph(a, 'abc');
    const clocks = a.stateVectorClocks();
    expect([...clocks.keys()]).toEqual([a.clientId]);
    expect(clocks.get(a.clientId)).toBeGreaterThan(0);
  });

  it('reports structs and deletions held back as pending until their dependencies arrive', () => {
    const a = createReplica();
    appendParagraph(a, 'abc');
    const first = a.encodeStateAsUpdate();
    const sv = a.encodeStateVector();
    insertText(a, 0, 3, 'def');
    const second = a.encodeStateAsUpdate(sv);
    const clock = a.stateVectorClocks().get(a.clientId)!;

    // `second` builds on `first`, so a replica without `first` keeps it pending.
    const b = createReplica();
    expect(b.pending()).toEqual({ inserts: new Map(), deletes: new Map() });
    b.applyUpdate(second);
    expect(b.pending().inserts).toEqual(new Map([[a.clientId, [{ from: clock - 3, to: clock }]]]));
    expect(b.plainText()).toBe('');

    b.applyUpdate(first);
    expect(b.pending()).toEqual({ inserts: new Map(), deletes: new Map() });
    expect(b.plainText()).toBe('abcdef');

    // A deletion of content the replica lacks is pending too.
    const c = createReplica();
    c.applyUpdate(first);
    const beforeDelete = a.encodeStateVector();
    deleteText(a, 0, 4, 2);
    c.applyUpdate(a.encodeStateAsUpdate(beforeDelete));
    expect(c.pending().deletes).toEqual(new Map([[a.clientId, [{ from: clock - 2, to: clock }]]]));
  });

  it("lists an update's inserted clock ranges per client, without its deletions", () => {
    const a = createReplica();
    const b = createReplica();
    appendParagraph(a, 'hello');
    b.applyUpdate(a.encodeStateAsUpdate());
    const aClock = a.stateVectorClocks().get(a.clientId)!;
    const sv = b.encodeStateVector();
    insertText(b, 0, 5, ' world');
    deleteText(b, 0, 0, 1); // deletes one of a's structs
    const bClock = b.stateVectorClocks().get(b.clientId)!;

    expect(b.insertRanges(b.encodeStateAsUpdate(sv))).toEqual(
      new Map([[b.clientId, [{ from: 0, to: bClock }]]]),
    );
    expect(b.insertRanges(b.encodeStateAsUpdate())).toEqual(
      new Map([
        [a.clientId, [{ from: 0, to: aClock }]],
        [b.clientId, [{ from: 0, to: bClock }]],
      ]),
    );
    expect(() => b.insertRanges(b.encodeStateAsUpdate().slice(0, -1))).toThrow();
  });

  it('knows which clocks it holds, integrated or pending', () => {
    const a = createReplica();
    appendParagraph(a, 'abc');
    const first = a.encodeStateAsUpdate();
    const sv = a.encodeStateVector();
    const mid = a.stateVectorClocks().get(a.clientId)!;
    insertText(a, 0, 3, 'def');
    const second = a.encodeStateAsUpdate(sv);
    const end = a.stateVectorClocks().get(a.clientId)!;

    const b = createReplica();
    expect(b.holds(a.clientId, [{ from: 0, to: 1 }])).toBe(false);
    expect(b.holds(a.clientId, [])).toBe(true);
    b.applyUpdate(second); // pending: depends on `first`
    expect(b.holds(a.clientId, [{ from: mid, to: end }])).toBe(true);
    expect(b.holds(a.clientId, [{ from: 0, to: end }])).toBe(false);
    expect(b.holds(a.clientId, [{ from: mid, to: end + 1 }])).toBe(false);
    b.applyUpdate(first);
    expect(b.holds(a.clientId, [{ from: 0, to: end }])).toBe(true);
    expect(
      b.holds(a.clientId, [
        { from: 0, to: mid },
        { from: mid, to: end },
      ]),
    ).toBe(true);
    expect(b.holds(b.clientId, [{ from: 0, to: 1 }])).toBe(false);
  });

  it('compares range maps', () => {
    const one = new Map([[1, [{ from: 0, to: 3 }]]]);
    expect(sameRanges(one, new Map([[1, [{ from: 0, to: 3 }]]]))).toBe(true);
    expect(sameRanges(one, new Map([[1, [{ from: 0, to: 4 }]]]))).toBe(false);
    expect(sameRanges(one, new Map([[2, [{ from: 0, to: 3 }]]]))).toBe(false);
    expect(sameRanges(one, new Map())).toBe(false);
  });

  it('extracts plain text with one line per text block', () => {
    const a = createReplica();
    appendParagraph(a, 'first');
    appendParagraph(a, 'second');
    expect(a.plainText()).toBe('first\nsecond');
  });

  it('attributes text to the actor that owns each client id', () => {
    const a = createReplica();
    const b = createReplica();
    appendParagraph(a, 'hello ');
    exchange(a, b);
    insertText(b, 0, 6, 'world');
    exchange(a, b);

    const actors = new Map([
      [a.clientId, 'device:mac'],
      [b.clientId, 'agent:claude'],
    ]);
    const runs = a.attribute((clientId) => actors.get(clientId));
    expect(runs).toEqual([
      { actor: 'device:mac', text: 'hello ' },
      { actor: 'agent:claude', text: 'world' },
    ]);
    // Unknown client ids are reported, not hidden.
    expect(b.attribute(() => undefined)).toEqual([{ actor: null, text: 'hello world' }]);
  });
});
