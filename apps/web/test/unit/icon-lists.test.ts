/**
 * The app's icon lists that the usage dashboard's session player draws too (PEN-178, T1): Settings'
 * nav icons (moved from SettingsPage's NAV into the settings index), the sidebar's shortcuts, the
 * phone's formatting bar and the note's bar. Each is pinned here, so moving them changed nothing
 * the app shows, and a change to one is a change the player follows.
 */
import { describe, expect, it } from 'vitest';
import { NOTE_BAR_BUTTONS, NOTE_BAR_BUTTON_INFO, noteBarShows } from '../../src/notes/note-bar';
import { PHONE_FORMAT_BUTTONS } from '../../src/notes/phone-format-buttons';
import { PRIVACY_DATA_ICON, SETTINGS_PAGES } from '../../src/pages/settings-index';
import { SHORTCUTS } from '../../src/shell/sidebar-shortcuts';
import { PREVIEW_TABS } from '../../src/theme/preview-tabs';

describe('the app icon lists', () => {
  it('gives each Settings page the icon its nav entry has always drawn', () => {
    expect(Object.fromEntries(SETTINGS_PAGES.map((page) => [page.id, page.icon]))).toEqual({
      appearance: 'palette',
      sidebar: 'panelL',
      note: 'file',
      symbols: 'star',
      journal: 'journal',
      'quick-capture': 'inbox',
      shortcuts: 'keyboard',
      'ai-descriptions': 'sparkle',
      'git-notebooks': 'terminal',
      agents: 'agentRef',
      'agent-activity': 'history',
      meaning: 'search',
      github: 'key',
      updates: 'refresh',
      privacy: 'shield',
    });
    expect(PRIVACY_DATA_ICON).toBe('checklist');
  });

  it('gives each Settings section its own icon (A902)', () => {
    const icons = [...SETTINGS_PAGES.map((page) => page.icon), PRIVACY_DATA_ICON];
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("keeps Appearance's, Sidebar's and Note's Settings and Preview tabs", () => {
    expect(PREVIEW_TABS.map((t) => [t.tab, t.label, t.icon])).toEqual([
      ['settings', 'Settings', 'settings'],
      ['preview', 'Preview', 'eye'],
    ]);
  });

  it("keeps the sidebar's shortcuts, the phone's formatting bar and the note's bar", () => {
    expect(SHORTCUTS.map((s) => [s.command, s.label, s.icon])).toEqual([
      ['app.search', 'Search', 'search'],
      ['app.tags', 'Tags', 'hash'],
      ['journal.today', 'Today', 'today'],
      ['journal.thisWeek', 'This Week', 'week'],
      ['app.graph', 'Graph', 'graph'],
      ['app.palette', 'Commands', 'command'],
    ]);
    expect(PHONE_FORMAT_BUTTONS.map((b) => [b.command, b.icon])).toEqual([
      ['editor.bold', 'bold'],
      ['editor.italic', 'italic'],
      ['editor.bulletList', 'list'],
      ['editor.taskList', 'checklist'],
      ['editor.code', 'code'],
      ['editor.link', 'link'],
      ['editor.undo', 'undo'],
      ['editor.redo', 'redo'],
    ]);
    expect(NOTE_BAR_BUTTONS.map((b) => NOTE_BAR_BUTTON_INFO[b].icon)).toEqual([
      'widthFull',
      'md',
      'md',
      'copy',
      'agentRef',
      'pin',
      'windowNew',
      'folder',
      'trash',
    ]);
    // With nothing chosen, Full Width and Copy Agent Reference show (A1134).
    expect(NOTE_BAR_BUTTONS.filter((b) => noteBarShows({}, b))).toEqual([
      'fullWidth',
      'copyAgentReference',
    ]);
  });
});
