/**
 * Session detail (PEN-177): block tokens and their grammar, the shape's caps, clampUsage, the
 * typing gate on a fake clock, replayShape, the props line the viewers show, and the ref key:
 * refs, the key file's race and reset, and that the key never leaves in a batch or a log line.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_PATTERN,
  blockToken,
  capShape,
  clampUsage,
  fitsShape,
  isShape,
  MAX_SHAPE_BYTES,
  MAX_SHAPE_TOKENS,
  replayShape,
  shapeBytes,
  textChange,
  TypingGate,
} from '../src/analytics/detail';
import { MAX_BATCH_BYTES, type AnalyticsEvent } from '../src/analytics/events';
import { eventProblem } from '../src/analytics/validate';
import { propsLine } from '../src/analytics/viewer';
import { readConsentFile, writeConsentFile } from '../src/analytics/node/consent-file';
import {
  readRefKey,
  REF_KEY_PATTERN,
  refKeyPathFor,
  refOf,
  renewRefKey,
  resetInstall,
} from '../src/analytics/node/ref-key';
import { batchBody } from '../src/analytics/node/sender';
import { scrubLogLine } from '../src/analytics/scrub';
import type { ScrollClock } from '../src/analytics/scroll';
import type { StoredEvent } from '../src/analytics/viewer';

class FakeClock implements ScrollClock {
  time = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  now = () => this.time;
  set(run: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, run });
    return id;
  }
  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(to: number): void {
    for (;;) {
      let due: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= to && (!due || entry[1].at < due[1].at)) due = entry;
      }
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].run();
    }
    this.time = to;
  }
}

const BASE = {
  session: '0123456789abcdef',
  seq: 0,
  at: 1_763_550_000_000,
  client: 'mac',
  actor: 'person',
  version: '1.4.0',
  channel: 'stable',
  os: 'macos',
  osVersion: '26.1',
} as const;

describe('block tokens', () => {
  it('name each kind, with a length for those with text', () => {
    expect(blockToken({ kind: 'p', chars: 182 })).toBe('p:182');
    expect(blockToken({ kind: 'h', level: 2, chars: 18 })).toBe('h2:18');
    expect(blockToken({ kind: 'li', list: 't', depth: 2, chars: 31 })).toBe('li.t.2:31');
    expect(blockToken({ kind: 'table', rows: 4, cols: 3, chars: 96 })).toBe('table.4x3:96');
    for (const kind of ['quote', 'code', 'callout', 'math', 'raw'] as const) {
      expect(blockToken({ kind, chars: 7 })).toBe(`${kind}:7`);
    }
    for (const kind of ['image', 'embed', 'hr', 'file', 'drawing', 'other'] as const) {
      expect(blockToken({ kind, chars: 7 })).toBe(kind);
    }
  });

  it('clamp what is out of range, so every token matches the pattern', () => {
    expect(blockToken({ kind: 'p', chars: 2_000_000 })).toBe('p:1000000');
    expect(blockToken({ kind: 'li', list: 'b', depth: 12, chars: 1 })).toBe('li.b.9:1');
    expect(blockToken({ kind: 'table', rows: 1200, cols: 0, chars: 1 })).toBe('table.999x1:1');
    expect(blockToken({ kind: 'h', level: 9, chars: 1 })).toBe('h6:1');
    expect(clampUsage('index', 6000)).toBe(5000);
    expect(clampUsage('chars', Number.NaN)).toBe(0);
  });

  it('can hold no word: the pattern takes only kinds and numbers', () => {
    for (const word of [
      'hello',
      'p:hello',
      'Plans',
      'code:js',
      'image:cat.png',
      'callout.warning',
    ]) {
      expect(BLOCK_PATTERN.test(word), word).toBe(false);
    }
  });
});

describe('the shape’s caps', () => {
  it('stops at 5,000 tokens, saying there is more', () => {
    const tokens = Array.from({ length: 6000 }, () => 'hr');
    const capped = capShape(tokens);
    expect(capped.shape).toHaveLength(MAX_SHAPE_TOKENS);
    expect(capped.more).toBe(true);
    expect(isShape(capped.shape)).toBe(true);
  });

  it('stops before 32 KB as JSON, counting quotes and commas', () => {
    const tokens = Array.from({ length: 3000 }, () => 'table.999x999:1000000');
    const capped = capShape(tokens);
    expect(capped.more).toBe(true);
    expect(JSON.stringify(capped.shape).length).toBe(shapeBytes(capped.shape));
    expect(shapeBytes(capped.shape)).toBeLessThanOrEqual(MAX_SHAPE_BYTES);
    expect(shapeBytes([...capped.shape, tokens[0]!])).toBeGreaterThan(MAX_SHAPE_BYTES);
    expect(isShape(capped.shape)).toBe(true);
    expect(fitsShape(tokens)).toBe(false);
  });

  it('keeps a shape that fits whole', () => {
    expect(capShape(['p:1', 'hr'])).toEqual({ shape: ['p:1', 'hr'], more: false });
    expect(capShape([])).toEqual({ shape: [], more: false });
  });

  it('makes the largest note open under 34 KB, and a batch of it fits 64 KB', () => {
    const { shape } = capShape(Array.from({ length: 6000 }, () => 'table.999x999:1000000'));
    const event = {
      ...BASE,
      sizeClass: 'expanded',
      kind: 'note',
      name: 'open',
      props: {
        note: '0123456789abcdef',
        folder: 'fedcba9876543210',
        how: 'switch',
        titleChars: 1_000_000,
        shape,
        more: true,
      },
    } as unknown as AnalyticsEvent;
    expect(eventProblem(event)).toBeNull();
    expect(new TextEncoder().encode(JSON.stringify(event)).length).toBeLessThan(34 * 1024);
    const stored = [event, event].map((each, id): StoredEvent => ({
      ...each,
      seq: id,
      id,
      state: 'waiting',
      sentAt: null,
    }));
    const { body, events } = batchBody('0123456789abcdef0123456789abcdef', stored);
    expect(events).toHaveLength(1);
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
  });
});

describe('TypingGate', () => {
  function gate() {
    const clock = new FakeClock();
    const bursts: Array<{ at: number; key: number; typed: number; deleted: number }> = [];
    const typing = new TypingGate<number>(
      (key, typed, deleted) => bursts.push({ at: clock.now(), key, typed, deleted }),
      clock,
    );
    return { clock, bursts, typing };
  }

  it('adds up a second of typing in a block as one burst', () => {
    const { clock, bursts, typing } = gate();
    for (let at = 0; at < 3000; at += 75) {
      clock.advance(at);
      typing.add(2, 1, 0);
    }
    clock.advance(10_000);
    expect(bursts.length).toBeGreaterThanOrEqual(3);
    expect(bursts.length).toBeLessThanOrEqual(4);
    expect(bursts.reduce((sum, each) => sum + each.typed, 0)).toBe(40);
    for (let i = 1; i < bursts.length; i++) {
      expect(bursts[i]!.at - bursts[i - 1]!.at).toBeGreaterThanOrEqual(1000);
    }
  });

  it('keeps each block’s own burst, and a second without change emits nothing', () => {
    const { clock, bursts, typing } = gate();
    typing.add(1, 3, 0);
    clock.advance(200);
    typing.add(4, 0, 2);
    clock.advance(5000);
    expect(bursts).toEqual([
      { at: 1000, key: 1, typed: 3, deleted: 0 },
      { at: 1200, key: 4, typed: 0, deleted: 2 },
    ]);
    typing.add(1, 0, 0);
    clock.advance(10_000);
    expect(bursts).toHaveLength(2);
  });

  it('counts a replacement both ways', () => {
    const { clock, bursts, typing } = gate();
    typing.add(0, 1, 5);
    clock.advance(1000);
    expect(bursts).toEqual([{ at: 1000, key: 0, typed: 1, deleted: 5 }]);
  });

  it('flushes every pending burst at once, oldest first, and stop drops them', () => {
    const { clock, bursts, typing } = gate();
    typing.add(3, 2, 0);
    typing.add(1, 1, 0);
    clock.advance(100);
    typing.flush();
    expect(bursts.map((each) => [each.at, each.key])).toEqual([
      [100, 3],
      [100, 1],
    ]);
    typing.add(5, 1, 0);
    typing.stop();
    clock.advance(5000);
    expect(bursts).toHaveLength(2);
    expect(typing.waiting).toBe(false);
  });
});

describe('replayShape', () => {
  const open = { note: 'aaaaaaaaaaaaaaaa', shape: ['h1:5', 'p:10', 'p:0'] };

  it('applies bursts and splices in order', () => {
    const events = [
      { kind: 'note', name: 'typing', props: { note: open.note, block: 1, typed: 5, deleted: 2 } },
      {
        kind: 'note',
        name: 'blocks',
        props: { note: open.note, block: 2, removed: 1, inserted: ['li.b.1:0', 'li.b.1:0'] },
      },
      { kind: 'note', name: 'typing', props: { note: open.note, block: 3, typed: 4, deleted: 0 } },
      {
        kind: 'note',
        name: 'typing',
        props: { note: open.note, title: true, typed: 9, deleted: 0 },
      },
      { kind: 'note', name: 'cursor', props: { note: open.note, block: 0 } },
    ];
    expect(replayShape(open, events)).toEqual(['h1:5', 'p:13', 'li.b.1:0', 'li.b.1:4']);
  });

  it('starts again at a resync, and skips another note’s events and other kinds', () => {
    const events = [
      { kind: 'note', name: 'typing', props: { note: 'bbbbbbbbbbbbbbbb', block: 0, typed: 5 } },
      { kind: 'scroll', name: 'note', props: { position: 0.5 } },
      { kind: 'note', name: 'open', props: { note: open.note, how: 'resync', shape: ['hr'] } },
      {
        kind: 'note',
        name: 'blocks',
        props: { note: open.note, block: 1, removed: 0, inserted: ['p:2'] },
      },
    ];
    expect(replayShape(open, events)).toEqual(['hr', 'p:2']);
  });

  it('leaves typing past the shape’s cap (no block) out', () => {
    expect(
      replayShape(open, [{ kind: 'note', name: 'typing', props: { typed: 3, deleted: 0 } }]),
    ).toEqual(open.shape);
  });
});

describe('textChange', () => {
  it('counts what differs between the common start and end', () => {
    expect(textChange('', 'abc')).toEqual({ typed: 3, deleted: 0 });
    expect(textChange('abc', 'ab')).toEqual({ typed: 0, deleted: 1 });
    expect(textChange('hello world', 'hello there world')).toEqual({ typed: 6, deleted: 0 });
    expect(textChange('hello world', 'hi world')).toEqual({ typed: 1, deleted: 4 });
    expect(textChange('aaa', 'aaaa')).toEqual({ typed: 1, deleted: 0 });
    expect(textChange('same', 'same')).toEqual({ typed: 0, deleted: 0 });
  });
});

describe('propsLine', () => {
  it('writes key: value pairs, a list by spaces, cut after 12 items', () => {
    expect(propsLine({ source: 'key', keys: 'Mod+K' })).toBe('source: key, keys: Mod+K');
    const shape = Array.from({ length: 500 }, (_, i) => `p:${i}`);
    expect(propsLine({ shape, more: true })).toBe(
      'shape: p:0 p:1 p:2 p:3 p:4 p:5 p:6 p:7 p:8 p:9 p:10 p:11 … +488, more: true',
    );
    expect(propsLine({ shape: shape.slice(0, 12) })).not.toContain('…');
    expect(propsLine({})).toBe('');
  });
});

describe('the ref key (PEN-177)', () => {
  const home = () => mkdtempSync(join(tmpdir(), 'penmoss-refkey-'));

  it('makes refs of 16 hex characters, the same for the same id and key, never the id', () => {
    const key = 'ab'.repeat(32);
    const ref = refOf(key, 'note', '01JB7Q3V6M8K2T9RZ4XN5C1HPD');
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(refOf(key, 'note', '01JB7Q3V6M8K2T9RZ4XN5C1HPD')).toBe(ref);
    expect(refOf(key, 'folder', '01JB7Q3V6M8K2T9RZ4XN5C1HPD')).not.toBe(ref);
    expect(refOf('cd'.repeat(32), 'note', '01JB7Q3V6M8K2T9RZ4XN5C1HPD')).not.toBe(ref);
  });

  it('is created once, kept with mode 0600, and read back the same', () => {
    const path = join(home(), 'analytics-key');
    const key = readRefKey(path);
    expect(key).toMatch(REF_KEY_PATTERN);
    expect(readRefKey(path)).toBe(key);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('agrees when two processes create it at once: the loser reads the winner’s', () => {
    const path = join(home(), 'analytics-key');
    const winner = 'e'.repeat(64);
    const key = readRefKey(path, { beforeCreate: () => writeFileSync(path, `${winner}\n`) });
    expect(key).toBe(winner);
    expect(readRefKey(path)).toBe(winner);
  });

  it('replaces a file that holds something else', () => {
    const path = join(home(), 'analytics-key');
    writeFileSync(path, 'not a key');
    const key = readRefKey(path);
    expect(key).toMatch(REF_KEY_PATTERN);
    expect(readFileSync(path, 'utf8').trim()).toBe(key);
  });

  it('survives analytics.json being rewritten without it, as a released CLI does', () => {
    const dir = home();
    const consent = join(dir, 'analytics.json');
    const keyPath = refKeyPathFor(consent);
    const key = readRefKey(keyPath);
    const file = readConsentFile(consent);
    // Today's CLI writes only the fields it knows.
    writeFileSync(consent, JSON.stringify({ v: 1, consent: 'yes', install: file.install }));
    writeConsentFile(readConsentFile(consent), consent);
    expect(readRefKey(keyPath)).toBe(key);
  });

  it('is new after the analytics ID is reset, with the new ID', () => {
    const dir = home();
    const consent = join(dir, 'analytics.json');
    const keyPath = refKeyPathFor(consent);
    const key = readRefKey(keyPath);
    const before = readConsentFile(consent);
    const after = resetInstall(consent, keyPath);
    expect(after.install).not.toBe(before.install);
    const next = readRefKey(keyPath);
    expect(next).not.toBe(key);
    expect(refOf(next, 'note', 'n1')).not.toBe(refOf(key, 'note', 'n1'));
    expect(renewRefKey(keyPath)).not.toBe(next);
  });

  it('never leaves in a log line: the scrubber replaces it', () => {
    const key = '0123456789abcdef'.repeat(4);
    expect(scrubLogLine(`analytics key ${key} loaded`)).not.toContain(key);
  });
});
