import { describe, expect, it } from 'vitest';
import { HOLD_MS, MainInbox } from '../../src/main-inbox';

// T51 (A945): what main sends the main window's page from the menu bar icon or a deep link is
// sent only to a page that listens, else held for it to take once it does.

const MAIN = 7;
const OTHER = 9;
const today = { kind: 'command', id: 'journal.today' } as const;
const note = { kind: 'path', path: '/n/01JZ0000000000000000000001' } as const;

function inbox(start = 1_000) {
  let now = start;
  const box = new MainInbox(() => now);
  return { box, advance: (ms: number) => (now += ms) };
}

describe('the main window’s inbox', () => {
  it('holds an item for a page that has not asked, and hands it over when it asks', () => {
    const { box } = inbox();
    expect(box.deliver(MAIN, today)).toBe('held');
    expect(box.take(MAIN)).toEqual(today);
    // Taken once.
    expect(box.take(MAIN)).toBeNull();
  });

  it('sends straight away once the page asked, even if the window still reports loading', () => {
    const { box } = inbox();
    expect(box.take(MAIN)).toBeNull();
    expect(box.deliver(MAIN, today)).toBe('send');
    expect(box.deliver(MAIN, note)).toBe('send');
    expect(box.holding).toBeNull();
  });

  it('holds paths as well as commands, the latest one winning', () => {
    const { box } = inbox();
    box.deliver(MAIN, today);
    box.deliver(MAIN, note);
    expect(box.take(MAIN)).toEqual(note);
  });

  it('a new document does not listen until it asks again', () => {
    const { box } = inbox();
    box.take(MAIN);
    box.navigated(MAIN);
    expect(box.deliver(MAIN, today)).toBe('held');
    // Held while the window loads: the new page takes it.
    box.navigated(MAIN);
    expect(box.take(MAIN)).toEqual(today);
  });

  it('drops an item held longer than the limit rather than running it much later', () => {
    const { box, advance } = inbox();
    box.deliver(MAIN, today);
    advance(HOLD_MS + 1);
    expect(box.take(MAIN)).toBeNull();
    expect(box.holding).toBeNull();
  });

  it('a closed window’s item goes with it, and another window does not take it', () => {
    const { box } = inbox();
    box.deliver(MAIN, today);
    expect(box.take(OTHER)).toBeNull();
    expect(box.holding).toEqual(today);
    box.closed(MAIN);
    expect(box.holding).toBeNull();
    expect(box.take(MAIN)).toBeNull();
  });

  it('a closed window no longer listens', () => {
    const { box } = inbox();
    box.take(MAIN);
    box.closed(MAIN);
    expect(box.deliver(MAIN, today)).toBe('held');
  });
});
