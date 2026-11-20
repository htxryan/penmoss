// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { eventProblem } from '@penmoss/core/analytics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useTrackedDialog } from '../../src/analytics/dialog';
import { flushRecorded } from '../../src/analytics/record';
import {
  installClickTracking,
  keysForEvent,
  recordScreen,
  recordSetting,
  resetScreens,
  screenKindOf,
  settingProps,
  withoutRecording,
} from '../../src/analytics/track';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What the page recorded (the web build's memory sink), flushed now. */
function recorded() {
  flushRecorded();
  return (window.__penmossAnalytics ?? []).map(({ kind, name, props }) => ({ kind, name, props }));
}

beforeEach(() => {
  window.__penmossAnalytics = [];
  resetScreens();
  document.body.innerHTML = '';
});

describe('the click listener (PEN-137)', () => {
  let stop: () => void = () => {};
  afterEach(() => stop());

  it('records a [data-event] control by its id, and a [data-command] one not at all', () => {
    stop = installClickTracking(document);
    document.body.innerHTML = `
      <button data-event="feedback.logs.preview"><span id="inner">Preview</span></button>
      <button data-command="app.settings" id="command">Settings</button>
      <div data-event="privacy.advanced"><button data-command="app.search" id="nested">Search</button></div>
      <button id="plain">Plain</button>`;
    document.getElementById('inner')!.click();
    document.getElementById('command')!.click();
    document.getElementById('nested')!.click();
    document.getElementById('plain')!.click();
    expect(recorded()).toEqual([{ kind: 'click', name: 'feedback.logs.preview', props: {} }]);
  });

  it('says which way a checkbox or a switch went', () => {
    stop = installClickTracking(document);
    document.body.innerHTML = `
      <input type="checkbox" data-event="feedback.logs.toggle" id="box" checked />
      <button role="switch" aria-checked="false" data-event="privacy.share.on" id="switch"></button>`;
    document.getElementById('box')!.click();
    document.getElementById('switch')!.click();
    expect(recorded()).toEqual([
      { kind: 'click', name: 'feedback.logs.toggle', props: { state: 'off' } },
      { kind: 'click', name: 'privacy.share.on', props: { state: 'on' } },
    ]);
  });

  it('drops an id the catalogue does not know, and a disabled control', () => {
    stop = installClickTracking(document);
    document.body.innerHTML = `
      <button data-event="nowhere.at-all" id="unknown"></button>
      <button data-event="privacy.advanced" id="off" disabled></button>`;
    document.getElementById('unknown')!.click();
    document.getElementById('off')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(recorded()).toEqual([]);
  });
});

describe('commands by name', () => {
  it('records a run with its source, and a key with its combination and whether it is custom', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings({ 'app.search': ['Mod+Shift+J'] }));
    center.register('app.settings', { run: () => {} });
    center.register('app.search', { run: () => {} });
    center.run('app.settings', { source: 'palette' });
    center.handleKeyDown(
      new KeyboardEvent('keydown', { code: 'KeyJ', key: 'J', ctrlKey: true, shiftKey: true }),
    );
    expect(recorded()).toEqual([
      { kind: 'command', name: 'app.settings', props: { source: 'palette', ran: true } },
      {
        kind: 'command',
        name: 'app.search',
        props: { source: 'key', ran: true, keys: 'Mod+Shift+J', custom: true },
      },
    ]);
    center.dispose();
  });

  it('records a menu choice that cannot run as not run, and nothing for other sources (PEN-170)', () => {
    const center = new CommandCenter(COMMANDS, memoryBindings({}));
    center.register('app.graph', { run: () => {}, enabled: () => false });
    expect(center.run('app.graph', { source: 'menu' })).toBe(false);
    expect(center.run('journal.calendar', { source: 'menu' })).toBe(false);
    expect(center.run('app.graph', { source: 'button' })).toBe(false);
    expect(recorded()).toEqual([
      { kind: 'command', name: 'app.graph', props: { source: 'menu', ran: false } },
      { kind: 'command', name: 'journal.calendar', props: { source: 'menu', ran: false } },
    ]);
    center.dispose();
  });

  it('writes combinations as the event format does, or not at all', () => {
    expect(keysForEvent('Mod+Shift+Up')).toBe('Mod+Shift+ArrowUp');
    expect(keysForEvent('Mod+Alt+N')).toBe('Mod+Alt+N');
    expect(keysForEvent('Ctrl+/')).toBe('Ctrl+/');
    expect(keysForEvent('Mod++')).toBeNull();
  });
});

describe('screens by kind', () => {
  it('maps routes to kinds, never ids', () => {
    expect(screenKindOf({ name: 'note', id: '01J00000000000000000000000' })).toBe('note');
    expect(screenKindOf({ name: 'window', id: '01J00000000000000000000000' })).toBe('note');
    expect(screenKindOf({ name: 'settings', section: 'appearance' })).toBe('settings.appearance');
    expect(
      screenKindOf({
        name: 'settings',
        section: 'git-notebooks',
        item: '01J00000000000000000000000',
      }),
    ).toBe('settings.git-notebook');
    expect(screenKindOf({ name: 'not-found' })).toBeNull();
  });

  it('records each change of kind with the one before', () => {
    recordScreen('home');
    recordScreen('home');
    recordScreen('note');
    expect(recorded()).toEqual([
      { kind: 'screen', name: 'home', props: {} },
      { kind: 'screen', name: 'note', props: { from: 'home' } },
    ]);
  });
});

describe('settings by name', () => {
  it('records a value only when it cannot be text', () => {
    expect(settingProps('note.fullWidth', true)).toEqual({ value: true });
    expect(settingProps('sidebar.recentCount', 7)).toEqual({ value: 7 });
    expect(settingProps('theme.id', 'nord')).toEqual({ value: 'nord' });
    expect(settingProps('theme.id', 'My Secret Theme')).toEqual({ value: 'custom' });
    expect(settingProps('font.note', 'custom:Zebracanary Sans')).toEqual({ value: 'custom' });
    expect(settingProps('capture.destination', 'inbox')).toEqual({ value: 'inbox' });
    expect(settingProps('template.daily', 'pangolincanary')).toEqual({ changed: true });
    expect(settingProps('timeZone', 'Europe/London')).toEqual({ changed: true });
  });

  it('sends a word only when core lists it for that setting, else changed', () => {
    expect(settingProps('theme.mode', 'system')).toEqual({ value: 'system' });
    expect(settingProps('font.interface', 'mono')).toEqual({ value: 'mono' });
    expect(settingProps('tooltip.delay', 'never')).toEqual({ value: 'never' });
    expect(settingProps('tooltip.delay', 1500)).toEqual({ value: 1500 });
    // A single word is still free text unless the setting may be that word.
    expect(settingProps('timeZone', 'UTC')).toEqual({ changed: true });
    expect(settingProps('theme.mode', 'Zebracanary')).toEqual({ changed: true });
    expect(settingProps('capture.destination', 'daily-notes')).toEqual({ changed: true });
    expect(settingProps('font.note', 'Helvetica')).toEqual({ changed: true });
    expect(settingProps('symbols.list', 'pangolincanary')).toEqual({ changed: true });
    expect(settingProps('quickAccess.showNotebook', 'Work')).toEqual({ changed: true });
    // What it sends, core takes.
    for (const [key, value] of [
      ['theme.mode', 'dark'],
      ['theme.id', 'My Secret Theme'],
      ['font.note', 'custom:Zebracanary Sans'],
      ['sidebar.recentCount', 12.5],
    ] as const) {
      const event = {
        session: '0123456789abcdef',
        seq: 0,
        at: 1,
        client: 'mac',
        actor: 'person',
        version: '1.4.0',
        channel: 'stable',
        os: 'macos',
        osVersion: '26.1',
        kind: 'setting',
        name: key,
        props: settingProps(key, value),
      };
      expect(eventProblem(event), `${key}: ${value}`).toBeNull();
    }
  });

  it('records allowlisted keys, a binding as shortcuts.custom, and nothing for a copy', () => {
    recordSetting('note.fullWidth', true);
    recordSetting('keys.app.search', ['Mod+Shift+J']);
    recordSetting('theme.custom.zebracanary', {});
    withoutRecording(() => recordSetting('note.fullWidth', false));
    expect(recorded()).toEqual([
      { kind: 'setting', name: 'note.fullWidth', props: { value: true } },
      { kind: 'setting', name: 'shortcuts.custom', props: { changed: true } },
    ]);
  });
});

describe('useTrackedDialog', () => {
  let finish: () => void = () => {};
  function Dialog() {
    const tracked = useTrackedDialog('cheatsheet');
    finish = () => tracked.done();
    return null;
  }

  it('records open, then done or cancel as it closes', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<Dialog />));
    act(() => root.render(<></>));
    act(() => root.render(<Dialog />));
    finish();
    act(() => root.unmount());
    expect(recorded()).toEqual([
      { kind: 'dialog', name: 'cheatsheet', props: { action: 'open' } },
      { kind: 'dialog', name: 'cheatsheet', props: { action: 'cancel', open: '<1s' } },
      { kind: 'dialog', name: 'cheatsheet', props: { action: 'open' } },
      { kind: 'dialog', name: 'cheatsheet', props: { action: 'done', open: '<1s' } },
    ]);
  });
});
