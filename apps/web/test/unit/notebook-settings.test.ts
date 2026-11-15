import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../../src/agents/activity';
import {
  EVERY,
  activityAgents,
  filterActivity,
  mergeActivity,
} from '../../src/sources/agent-activity-list';
import { CONTROL_TAB, notebookTab, notebookTabPath } from '../../src/sources/notebook-tabs';
import {
  PULL_CHOICES,
  PUSH_CHOICES,
  agoWords,
  dotState,
  pullChoices,
  pullWords,
  pushChoices,
  pushWords,
  syncLine,
} from '../../src/sources/sync-words';

// PEN-146: Settings → Notebooks' words and tabs, and Agent Activity across notebooks.

const ID = '01JB0000000000000000000000';

describe('a notebook’s sync in words', () => {
  it('names the cadence in words, not numbers with units', () => {
    expect(pushWords(12)).toBe('After 12 Seconds');
    expect(pushWords(60)).toBe('After 1 Minute');
    expect(pushWords(120)).toBe('After 2 Minutes');
    expect(pushWords(3600)).toBe('After 1 Hour');
    expect(pullWords(1)).toBe('Every Minute');
    expect(pullWords(2)).toBe('Every 2 Minutes');
    expect(pullWords(60)).toBe('Every Hour');
    expect(pullWords(120)).toBe('Every 2 Hours');
  });

  it('offers the usual choices, with the defaults among them (A825: 12 s and 1 min)', () => {
    expect(PUSH_CHOICES).toContain(12);
    expect(PULL_CHOICES).toContain(1);
    expect(pushChoices(12).map((choice) => choice.value)).toEqual([...PUSH_CHOICES]);
    // Every choice is in main's range: 5 s to an hour, 1 minute to a day.
    expect(PUSH_CHOICES.every((value) => value >= 5 && value <= 3600)).toBe(true);
    expect(PULL_CHOICES.every((value) => value >= 1 && value <= 1440)).toBe(true);
  });

  it('keeps a value set before that is not one of the menu’s, in its place', () => {
    expect(pushChoices(45).map((choice) => choice.label)).toEqual([
      'After 5 Seconds',
      'After 12 Seconds',
      'After 30 Seconds',
      'After 45 Seconds',
      'After 1 Minute',
      'After 2 Minutes',
      'After 5 Minutes',
      'After 10 Minutes',
    ]);
    expect(pullChoices(7).map((choice) => choice.value)).toEqual([1, 2, 5, 7, 10, 15, 30, 60]);
  });

  it('says how long ago it synced, and the dot’s state', () => {
    const now = Date.UTC(2026, 10, 15, 12, 0);
    expect(agoWords(now - 20_000, now)).toBe('just now');
    expect(agoWords(now - 2 * 60_000, now)).toBe('2 min ago');
    expect(agoWords(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(syncLine({ phase: 'synced', lastSyncAt: now - 2 * 60_000 }, now)).toBe(
      'Synced 2 min ago',
    );
    expect(syncLine({ phase: 'stopped', lastSyncAt: now })).toBe('Sync Stopped');
    expect(syncLine({ phase: 'synced', lastSyncAt: now, closing: true })).toBe('Pushing…');
    expect(dotState({ phase: 'synced' })).toBe('ok');
    expect(dotState({ phase: 'starting' })).toBe('syncing');
    expect(dotState({ phase: 'syncing' })).toBe('syncing');
    expect(dotState({ phase: 'offline' })).toBe('offline');
    expect(dotState({ phase: 'stopped' })).toBe('error');
  });
});

describe('a notebook’s tabs', () => {
  it('keeps the tab in the URL, Overview with none', () => {
    expect(notebookTab('')).toBe('overview');
    expect(notebookTab('?tab=sync')).toBe('sync');
    expect(notebookTab('?tab=git')).toBe('git');
    expect(notebookTab('?tab=agents')).toBe('overview');
    expect(notebookTabPath(ID, 'overview')).toBe(`/settings/git-notebooks/${ID}`);
    expect(notebookTabPath(ID, 'git')).toBe(`/settings/git-notebooks/${ID}?tab=git`);
  });

  it('opens the tab a command’s control is on (#170 F5)', () => {
    expect(CONTROL_TAB['git-pull-interval']).toBe('sync');
    expect(CONTROL_TAB['git-push-delay']).toBe('sync');
    expect(CONTROL_TAB['git-author-email']).toBe('git');
    expect(CONTROL_TAB['git-token']).toBe('git');
    expect(CONTROL_TAB['git-remove']).toBe('overview');
  });
});

const entry = (id: number, at: number, agent: string, summary = `Change ${id}`): ActivityEntry => ({
  id,
  at,
  actor: { id: `agent:${agent}`, label: agent },
  kinds: ['folder.create'],
  summary,
  undoneAt: null,
  undoneBy: null,
});

describe('Agent Activity across notebooks', () => {
  const lists = [
    {
      notebookId: 'a',
      notebook: 'Personal',
      entries: [entry(1, 100, 'Claude Code'), entry(2, 300, 'Claude Code')],
    },
    { notebookId: 'b', notebook: 'Docs', entries: [entry(1, 200, 'Codex')] },
  ];

  it('lists every notebook’s changes in one list, newest first, each with its notebook', () => {
    const merged = mergeActivity(lists);
    expect(merged.map((item) => `${item.notebook}:${item.entry.id}`)).toEqual([
      'Personal:2',
      'Docs:1',
      'Personal:1',
    ]);
    expect(activityAgents(merged)).toEqual(['Claude Code', 'Codex']);
  });

  it('filters by notebook and by agent', () => {
    const merged = mergeActivity(lists);
    expect(filterActivity(merged, EVERY, EVERY)).toHaveLength(3);
    expect(filterActivity(merged, 'b', EVERY).map((item) => item.notebook)).toEqual(['Docs']);
    expect(filterActivity(merged, EVERY, 'Claude Code')).toHaveLength(2);
    expect(filterActivity(merged, 'b', 'Claude Code')).toEqual([]);
  });
});
