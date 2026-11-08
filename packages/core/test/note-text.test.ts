import { describe, expect, it } from 'vitest';
import { capNoteText, MAX_NOTE_TEXT_BYTES } from '../src/search';

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('capNoteText (T40 P6, FD4)', () => {
  it('keeps text under the cap as it is', () => {
    expect(capNoteText('hello')).toBe('hello');
    const exact = 'a'.repeat(MAX_NOTE_TEXT_BYTES);
    expect(capNoteText(exact)).toBe(exact);
  });

  it('cuts longer text to the cap', () => {
    const long = 'a'.repeat(MAX_NOTE_TEXT_BYTES + 10);
    expect(capNoteText(long)).toHaveLength(MAX_NOTE_TEXT_BYTES);
  });

  it('never cuts inside a character', () => {
    // 'é' is two bytes and '😀' four: a cut inside either drops the whole character.
    expect(capNoteText('aé', 2)).toBe('a');
    expect(capNoteText('a😀', 4)).toBe('a');
    expect(capNoteText('a😀', 5)).toBe('a😀');
    const mixed = 'é'.repeat(MAX_NOTE_TEXT_BYTES);
    const cut = capNoteText(mixed);
    expect(bytes(cut)).toBeLessThanOrEqual(MAX_NOTE_TEXT_BYTES);
    expect(cut).toBe('é'.repeat(MAX_NOTE_TEXT_BYTES / 2));
  });
});
