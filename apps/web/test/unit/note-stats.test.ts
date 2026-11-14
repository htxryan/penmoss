import { describe, expect, it } from 'vitest';
import { gitSaveStatus } from '../../src/notes/save-status';
import {
  charactersLabel,
  docText,
  readingLabel,
  textStats,
  wordsLabel,
} from '../../src/notes/stats';
import { loadTokenCounter, tokensLabel } from '../../src/notes/tokens';

// T41 (A505): the status bar's counts and the open note's save status.

describe('word and character counts', () => {
  it('counts words joined by apostrophes, hyphens and full stops as one', () => {
    expect(textStats('Don’t re-read the well-known v3.5 notes.').words).toBe(6);
    expect(textStats("It's a dog's life").words).toBe(4);
    expect(textStats('  ').words).toBe(0);
    expect(textStats('one,two;three — four').words).toBe(4);
  });

  it('counts each Han or kana character as a word', () => {
    expect(textStats('日本語のメモ').words).toBe(6);
    expect(textStats('Penmoss 笔记').words).toBe(3);
  });

  it('counts code points, spaces included, line breaks not', () => {
    expect(textStats('ab c').characters).toBe(4);
    expect(textStats('a\nb').characters).toBe(2);
    expect(textStats('🌿 moss').characters).toBe(6);
  });

  it('reads at 230 words a minute, at least a minute', () => {
    expect(textStats('').minutes).toBe(0);
    expect(textStats('word').minutes).toBe(1);
    expect(textStats('w '.repeat(1150)).minutes).toBe(5);
    expect(readingLabel(0)).toBe('');
    expect(readingLabel(5)).toBe('5 min read');
  });

  it('formats counts with separators and plurals', () => {
    expect(wordsLabel(1)).toBe('1 word');
    expect(wordsLabel(12_034)).toBe('12,034 words');
    expect(charactersLabel(0)).toBe('0 characters');
  });

  it('reads a document’s text with blocks on their own lines', () => {
    const calls: unknown[] = [];
    const doc = {
      content: { size: 10 },
      textBetween: (...args: unknown[]) => {
        calls.push(args);
        return 'a\nb';
      },
    };
    expect(docText(doc)).toBe('a\nb');
    expect(calls).toEqual([[0, 10, '\n']]);
    docText(doc, 2, 4);
    expect(calls[1]).toEqual([2, 4, '\n']);
  });

  it('counts a 10,000-word note (how fast is a budget: note-stats.budget.test.ts)', () => {
    const text = 'garden river morning window '.repeat(2500);
    expect(textStats(text).words).toBe(10_000);
  });
});

describe('Token Count (feedback of 6 Nov 2026)', () => {
  it('counts with GPT-4o’s encoding, a special token’s spelling as text', async () => {
    const count = await loadTokenCounter();
    expect(count('')).toBe(0);
    expect(count('hello world')).toBe(2);
    // Refused by default; here it is only words in a note.
    expect(count('before <|endoftext|> after')).toBeGreaterThan(3);
    // Loaded once.
    expect(await loadTokenCounter()).toBe(count);
  });

  it('formats counts with separators and plurals', () => {
    expect(tokensLabel(1)).toBe('1 token');
    expect(tokensLabel(12_034)).toBe('12,034 tokens');
  });
});

describe('a git note’s save status (A860)', () => {
  const local = { savedLocally: true, persistError: null };
  const sync = (phase: 'offline' | 'syncing' | 'synced' | 'stopped', pending: string[] = []) => ({
    phase,
    detail: phase === 'offline' ? 'Can’t reach github.com' : null,
    pending: new Set(pending),
  });

  it('says git, never the server', () => {
    expect(gitSaveStatus(local, sync('synced'), 'N')).toMatchObject({
      state: 'synced',
      label: 'Saved · in git',
    });
    expect(gitSaveStatus(local, sync('synced', ['N']), 'N')).toMatchObject({
      state: 'syncing',
      label: 'Saved here · not pushed yet',
    });
    expect(gitSaveStatus(local, sync('offline', ['N']), 'N')).toMatchObject({
      state: 'offline',
      label: 'Saved here · offline',
    });
    expect(gitSaveStatus(local, sync('offline', ['N']), 'N').hint).toContain('github.com');
    expect(gitSaveStatus(local, sync('offline'), 'N').label).toBe('Saved · offline');
    expect(gitSaveStatus(local, sync('stopped'), 'N')).toMatchObject({
      state: 'stopped',
      label: 'Sync Stopped',
    });
    expect(gitSaveStatus({ ...local, savedLocally: false }, sync('synced'), 'N').state).toBe(
      'saving',
    );
    for (const phase of ['offline', 'syncing', 'synced', 'stopped'] as const) {
      expect(gitSaveStatus(local, sync(phase, ['N']), 'N').hint).not.toMatch(/server/i);
    }
  });

  // The only note there is since T59 (D49): a failed write on this device comes first.
  it('says Not saved when this device could not store the note, whatever git says', () => {
    expect(
      gitSaveStatus({ ...local, persistError: new Error('quota') }, sync('synced'), 'N'),
    ).toMatchObject({ state: 'error', label: 'Not saved' });
    expect(
      gitSaveStatus({ ...local, persistError: new Error('quota') }, sync('synced'), 'N').hint,
    ).toContain('quota');
  });
});
