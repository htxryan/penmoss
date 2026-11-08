import { describe, expect, it, vi } from 'vitest';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { isKeyRepeat, isRepeatedNewNote, NEW_NOTE_REPEAT_MS } from '../../src/notes/new-note';

describe('New note once per gesture (T39)', () => {
  const last = { id: 'n1', at: 10_000 };
  const untitled = { id: 'n1', title: '' };

  it('ignores a second New note while the note it just made is open and untitled', () => {
    expect(isRepeatedNewNote(last, untitled, 10_000 + 150)).toBe(true);
  });

  it('makes another note once the first has a title, however soon', () => {
    // Type a title, press New note: a second note was meant.
    expect(isRepeatedNewNote(last, { id: 'n1', title: 'Shopping' }, 10_000 + 150)).toBe(false);
    expect(isRepeatedNewNote(last, { id: 'n1', title: '   ' }, 10_000 + 150)).toBe(true);
  });

  it('makes another note once the moment has passed', () => {
    expect(isRepeatedNewNote(last, untitled, 10_000 + NEW_NOTE_REPEAT_MS)).toBe(false);
  });

  it('makes another note when a different note is open', () => {
    expect(isRepeatedNewNote(last, { id: 'other', title: '' }, 10_000 + 150)).toBe(false);
    expect(isRepeatedNewNote(last, null, 10_000 + 150)).toBe(false);
  });

  it('makes the first note', () => {
    expect(isRepeatedNewNote(null, null, 10_000)).toBe(false);
  });
});

describe('New note from a held shortcut (T39 review)', () => {
  /** Alt+N as the dispatcher reads it; `repeat` is set while the key is held. */
  const altN = (repeat: boolean) => {
    const event = {
      code: 'KeyN',
      key: 'n',
      ctrlKey: false,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      isComposing: false,
      repeat,
      defaultPrevented: false,
      target: null,
      preventDefault: vi.fn(() => {
        event.defaultPrevented = true;
      }),
      stopPropagation: vi.fn(),
    };
    return event as unknown as KeyboardEvent;
  };

  it('makes one note however long the key is held, and the repeats type nothing', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings({ 'note.new': ['Alt+N'] }));
    const create = vi.fn();
    // As the app registers it (App.tsx).
    center.register('note.new', {
      run: (context) => {
        if (!isKeyRepeat(context)) create();
      },
    });

    expect(center.handleKeyDown(altN(false))).toBe(true);
    const repeats = Array.from({ length: 40 }, () => altN(true));
    for (const repeat of repeats) expect(center.handleKeyDown(repeat)).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(repeats.every((repeat) => repeat.defaultPrevented)).toBe(true);

    // Released and pressed again: another note.
    center.handleKeyDown(altN(false));
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('runs from the button, the palette and the menu, which have no key event', () => {
    expect(isKeyRepeat({})).toBe(false);
    expect(isKeyRepeat({ event: { repeat: false } })).toBe(false);
    expect(isKeyRepeat({ event: { repeat: true } })).toBe(true);
  });
});
