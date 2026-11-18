import { describe, expect, it } from 'vitest';
import { DEFAULT_DAILY_TEMPLATE, DEFAULT_WEEKLY_TEMPLATE } from '../src/periodic';
import {
  isLocalSetting,
  isPlatformSetting,
  captureDestinationOf,
  DAD_JOKES_SETTING,
  dadJokesOf,
  fullWidthOf,
  isNotebookSetting,
  noteBarSetting,
  templateOf,
  templateSetting,
  timeZoneOf,
} from '../src/settings';

describe('the synced settings with no feature module of their own', () => {
  it('uses America/Chicago until a time zone is set, and ignores one it does not know (T19)', () => {
    expect(timeZoneOf({})).toBe('America/Chicago');
    expect(timeZoneOf({ timeZone: 'Asia/Tokyo' })).toBe('Asia/Tokyo');
    expect(timeZoneOf({ timeZone: 'Mars/Olympus' })).toBe('America/Chicago');
    expect(timeZoneOf({ timeZone: 42 })).toBe('America/Chicago');
  });

  it('uses the saved template, the empty one included, or the default', () => {
    expect(templateOf({}, 'daily')).toBe(DEFAULT_DAILY_TEMPLATE);
    expect(templateOf({}, 'weekly')).toBe(DEFAULT_WEEKLY_TEMPLATE);
    expect(templateOf({ 'template.daily': '# {{date}}\n' }, 'daily')).toBe('# {{date}}\n');
    expect(templateOf({ 'template.weekly': '' }, 'weekly')).toBe('');
    expect(templateSetting('weekly')).toBe('template.weekly');
  });

  it('starts Quick Capture on today’s note unless the Inbox is chosen (A947)', () => {
    expect(captureDestinationOf({})).toBe('daily');
    expect(captureDestinationOf({ 'capture.destination': 'inbox' })).toBe('inbox');
    expect(captureDestinationOf({ 'capture.destination': 'elsewhere' })).toBe('daily');
  });

  it('heads the empty window with a dad joke unless Dad Jokes is turned off (A1598)', () => {
    expect(DAD_JOKES_SETTING).toBe('home.dadJokes');
    expect(dadJokesOf({})).toBe(true);
    expect(dadJokesOf({ 'home.dadJokes': true })).toBe(true);
    expect(dadJokesOf({ 'home.dadJokes': false })).toBe(false);
    // A value another client wrote that this one does not know keeps the default.
    expect(dadJokesOf({ 'home.dadJokes': 'off' })).toBe(true);
    expect(isNotebookSetting('home.dadJokes')).toBe(false);
  });

  it('reads full width as true only for true, and null while unset (A501)', () => {
    expect(fullWidthOf({})).toBeNull();
    expect(fullWidthOf({ 'note.fullWidth': true })).toBe(true);
    expect(fullWidthOf({ 'note.fullWidth': 'yes' })).toBe(false);
    expect(noteBarSetting('move')).toBe('noteBar.move');
  });

  it('keeps the time zone and templates as the notebook’s own, every other key a device’s (A827)', () => {
    expect(isNotebookSetting('timeZone')).toBe(true);
    expect(isNotebookSetting('template.daily')).toBe(true);
    expect(isNotebookSetting('theme.id')).toBe(false);
    expect(isNotebookSetting('capture.destination')).toBe(false);
  });
});

describe('isPlatformSetting (PEN-156, A1605)', () => {
  it('names the look, the sidebar layout and the keyboard shortcuts', () => {
    for (const key of [
      'theme.id',
      'theme.mode',
      'font.interface',
      'font.note',
      'font.noteSize',
      'sidebar.tags',
      'sidebar.today',
      'sidebar.thisWeek',
      'sidebar.graph',
      'sidebar.commands',
      'sidebar.sectionOrder',
      'sidebar.hiddenSections',
      'sidebar.recentCount',
      'quickAccess.showNotebook',
      'quickAccess.inDrawer',
      'keys.app.search',
    ]) {
      expect(isPlatformSetting(key), key).toBe(true);
    }
  });

  it('leaves the shared settings shared', () => {
    for (const key of [
      'theme.custom.ink',
      'quickAccess.notes',
      'symbols.list',
      'capture.destination',
      'timeZone',
      'template.daily',
      'badge.color',
      'note.fullWidth',
      'tooltip.delay',
    ]) {
      expect(isPlatformSetting(key), key).toBe(false);
    }
  });
});

describe('isLocalSetting (A1626)', () => {
  it('keeps Appearance, the sidebar or Home, and the note’s look on each device', () => {
    for (const key of [
      'theme.id',
      'theme.mode',
      'font.note',
      'font.noteSize',
      'tooltip.delay',
      'home.dadJokes',
      'sidebar.graph',
      'sidebar.hiddenSections',
      'sidebar.recentCount',
      'quickAccess.showNotebook',
      'quickAccess.inDrawer',
      'note.fullWidth',
      'noteBar.delete',
      'metadata.underTitle',
      'metadata.statusBar',
    ]) {
      expect(isLocalSetting(key), key).toBe(true);
    }
  });

  it('syncs custom themes, symbols, the shortcuts and the rest', () => {
    for (const key of [
      'theme.custom.ink',
      'symbols.list',
      'keys.app.search',
      'quickAccess.notes',
      'capture.destination',
      'timeZone',
      'template.daily',
      'badge.color',
    ]) {
      expect(isLocalSetting(key), key).toBe(false);
    }
  });
});
