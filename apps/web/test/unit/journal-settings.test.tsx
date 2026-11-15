// @vitest-environment happy-dom
import { fillTemplate, longDate, todayIn } from '@penmoss/core/periodic';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JournalSettings } from '../../src/journal/JournalSettings';
import { previewLines } from '../../src/journal/template-preview';
import { utcOffset, zoneName } from '../../src/journal/time-zones';
import { WorkspaceContext } from '../../src/workspace/hooks';
import type { Workspace } from '../../src/workspace/service';

// PEN-146 (option B): Settings → Daily Notes' time zone is a searchable picker, and the
// templates are tabs over one editor that saves as you type, beside a preview of the note the
// template makes, filled in by the same fillTemplate the note is made with (A78).

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let host: HTMLDivElement;
let settings: Record<string, unknown>;
let writes: Array<[string, unknown]>;

const workspace = {
  settings: () => ({ ...settings }),
  setSetting: (key: string, value: unknown) => {
    writes.push([key, value]);
    if (value === undefined) delete settings[key];
    else settings[key] = value;
    state = {}; // a new state, as the workspace's is after a change
    listeners.forEach((listener) => listener());
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getState: () => state,
} as unknown as Workspace;
const listeners = new Set<() => void>();
let state = {};

function render() {
  act(() =>
    root!.render(
      <WorkspaceContext.Provider value={workspace}>
        <JournalSettings />
      </WorkspaceContext.Provider>,
    ),
  );
}

beforeEach(() => {
  settings = {};
  writes = [];
  state = {};
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.useRealTimers();
});

const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const type = (field: HTMLTextAreaElement | HTMLInputElement, value: string) =>
  act(() => {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const textarea = () => $<HTMLTextAreaElement>('[data-testid="template-input"]');
const preview = () => $('[data-testid="template-preview"]');
const status = () => $('[data-testid="template-status"]').textContent;

describe('Settings → Daily Notes → Time Zone', () => {
  it('says what today is in the zone, with the zone and its offset on the button', () => {
    settings.timeZone = 'Pacific/Kiritimati';
    render();
    const row = $('[data-setting="time-zone"]');
    const day = todayIn('Pacific/Kiritimati');
    expect(row.dataset.today).toBe(day.toString());
    expect(row.textContent).toContain(`Today is ${longDate(day)}.`);
    const button = row.querySelector('button')!;
    expect(button.textContent).toContain(zoneName('Pacific/Kiritimati'));
    expect(button.textContent).toContain(utcOffset('Pacific/Kiritimati'));
  });

  it('finds a zone by typing part of its name, and Return chooses it', () => {
    render();
    act(() => $<HTMLButtonElement>('[data-setting="time-zone"] button').click());
    const field = $<HTMLInputElement>('[data-testid="time-zone-picker"] input');
    expect(document.activeElement).toBe(field);
    type(field, 'kiritimati');
    const options = [
      ...document.querySelectorAll('[data-testid="time-zone-picker"] [role="option"]'),
    ];
    expect(options.map((option) => (option as HTMLElement).dataset.zone)).toEqual([
      'Pacific/Kiritimati',
    ]);
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(writes).toEqual([['timeZone', 'Pacific/Kiritimati']]);
    expect(document.querySelector('[data-testid="time-zone-picker"]')).toBeNull();
  });

  it('offers this device’s own zone first, and Escape closes without a change', () => {
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    render();
    act(() => $<HTMLButtonElement>('[data-setting="time-zone"] button').click());
    const first = $('[data-testid="time-zone-picker"] [role="option"]');
    expect(first.dataset.zone).toBe(own);
    expect(first.textContent).toContain('Use This Device’s Zone');
    act(() => {
      $('[data-testid="time-zone-picker"] input').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.querySelector('[data-testid="time-zone-picker"]')).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe('Settings → Daily Notes → the templates', () => {
  it('saves half a second after the last key, says Saved, and has no Save button', () => {
    vi.useFakeTimers();
    render();
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Save');
    type(textarea(), '# {{longDate}}\n\n## Log\n');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(writes).toEqual([]);
    type(textarea(), '# {{longDate}}\n\n## Log\n- [ ] Plan\n');
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(writes).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(writes).toEqual([['template.daily', '# {{longDate}}\n\n## Log\n- [ ] Plan\n']]);
    expect(status()).toBe('Saved');
  });

  it('previews today’s note with the placeholders filled in', () => {
    settings.timeZone = 'America/Chicago';
    settings['template.daily'] = '# {{longDate}}\n\n## Captures\n- [ ] Call {{weekday}}\n';
    render();
    const day = todayIn('America/Chicago').toString();
    const text = preview().textContent;
    expect(text).toContain('Today’s Note');
    expect(text).toContain(day);
    const filled = fillTemplate(settings['template.daily'] as string, 'daily', day);
    expect(text).toContain(filled.split('\n')[0]!.slice(2));
    expect(preview().querySelector('.pv-h1')?.textContent).toBe(filled.split('\n')[0]!.slice(2));
    expect(preview().querySelector('.pv-h2')?.textContent).toBe('Captures');
    expect(preview().querySelector('.pv-item')?.textContent).toMatch(/^☐ Call \w+day$/);
  });

  it('switches to the weekly template, with this week’s note beside it', () => {
    render();
    const weekly = $<HTMLButtonElement>('[data-testid="template-tab-weekly"]');
    expect(weekly.getAttribute('data-setting')).toBe('weekly-template');
    expect($('[data-testid="template-tab-daily"]').getAttribute('data-setting')).toBe(
      'daily-template',
    );
    act(() => weekly.click());
    expect(weekly.getAttribute('aria-selected')).toBe('true');
    expect(textarea().value).toBe('## Goals\n\n## Review\n');
    expect(preview().textContent).toContain('This Week’s Note');
    expect(preview().textContent).toMatch(/\d{4}-W\d{2}/);
  });

  it('inserts a placeholder from the menu where the cursor is', () => {
    vi.useFakeTimers();
    settings['template.daily'] = '# \n';
    render();
    textarea().setSelectionRange(2, 2);
    act(() => $<HTMLButtonElement>('[data-testid="template-placeholder"]').click());
    act(() => $<HTMLButtonElement>('[data-testid="placeholder-longDate"]').click());
    expect(textarea().value).toBe('# {{longDate}}\n');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(writes).toEqual([['template.daily', '# {{longDate}}\n']]);
  });

  it('saves what was typed when the page closes before the delay', () => {
    vi.useFakeTimers();
    render();
    type(textarea(), 'Typed, then left');
    act(() => root!.unmount());
    root = null;
    expect(writes).toEqual([['template.daily', 'Typed, then left']]);
  });

  it('Reset to Default removes the setting and shows the default', () => {
    settings['template.daily'] = 'Mine';
    render();
    const reset = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Reset to Default',
    )!;
    act(() => reset.click());
    expect(writes).toEqual([['template.daily', undefined]]);
    expect(textarea().value).toBe('## Plan\n\n## Notes\n');
    expect(status()).toBe('Back to the default');
    expect(reset.disabled).toBe(true);
  });
});

describe('the preview’s lines', () => {
  it('reads headings, tasks, list items, quotes and text, and skips blank lines', () => {
    expect(previewLines('# A\n\n## B\n- [ ] t\n- [x] d\n- i\n1. n\n> q\nplain')).toEqual([
      { kind: 'h1', text: 'A' },
      { kind: 'h2', text: 'B' },
      { kind: 'task', text: 't', done: false },
      { kind: 'task', text: 'd', done: true },
      { kind: 'item', text: 'i', marker: '•' },
      { kind: 'item', text: 'n', marker: '1.' },
      { kind: 'quote', text: 'q' },
      { kind: 'text', text: 'plain' },
    ]);
  });
});
