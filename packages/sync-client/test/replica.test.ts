import { describe, expect, it } from 'vitest';
import type { Replica } from '../src/replica';
import { appendParagraph, createReplica, insertText } from './support/editing';

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

  it('extracts plain text with one line per text block', () => {
    const a = createReplica();
    appendParagraph(a, 'first');
    appendParagraph(a, 'second');
    expect(a.plainText()).toBe('first\nsecond');
  });
});
