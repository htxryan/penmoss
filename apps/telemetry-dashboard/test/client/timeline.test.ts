// @vitest-environment happy-dom
// A session's timeline (PEN-173): one list of events and one current index, changed only by
// setCurrent, so PEN-178's Play can drive it; a click or Arrow Up, Arrow Down, Home and End in the
// timeline move it, marking one row only.
import { describe, expect, it, vi } from 'vitest';
import { createTimeline, type TimelineEvent } from '../../src/client/timeline';

const event = (
  seq: number,
  kind: string,
  name: string,
  props: TimelineEvent['props'] = {},
): TimelineEvent => ({
  seq,
  at: 1_000_000 + seq * 10_000,
  client: 'mac',
  actor: 'person',
  version: '1.4.0',
  channel: 'stable',
  os: 'macos',
  os_version: '26.1',
  size_class: 'expanded',
  kind,
  name,
  props,
});

const EVENTS = [
  event(0, 'app', 'launch'),
  event(1, 'screen', 'home'),
  event(2, 'command', 'app.palette', { source: 'key', keys: 'Mod+K', custom: false, ran: true }),
  event(3, 'command', 'note.new', { source: 'palette', ran: true }),
  event(4, 'screen', 'note', { from: 'home' }),
];

const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('li.ev')];
const marked = (root: HTMLElement) =>
  rows(root)
    .filter((row) => row.getAttribute('aria-current') === 'true')
    .map((row) => Number(row.dataset['index']));
const key = (root: HTMLElement, name: string) => {
  const press = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  root.dispatchEvent(press);
  return press;
};

describe('createTimeline', () => {
  it('draws every event from its one list, in stretches by screen, each row with its index', () => {
    const timeline = createTimeline(EVENTS);
    expect(timeline.events).toBe(EVENTS);
    expect(rows(timeline.element).map((row) => row.dataset['index'])).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
    ]);
    const headings = [...timeline.element.querySelectorAll('.stretch-title')].map((h) =>
      h.firstChild?.textContent?.trim(),
    );
    expect(headings).toEqual(['Before Any Screen', 'Home', 'Note']);
    const palette = rows(timeline.element)[2]!;
    expect(palette.querySelector('.ev-since')!.textContent).toBe('0:20');
    expect(palette.querySelector('.ev-gap')!.textContent).toBe('+10s');
    expect(palette.querySelector('.ev-kind')!.textContent).toBe('Command');
    expect(palette.querySelector('.ev-name')!.textContent).toBe('Command Paletteapp.palette');
    expect([...palette.querySelectorAll('.prop-chip')].map((chip) => chip.textContent)).toEqual([
      'Source Key',
      'Keys Mod+K',
      'Own Shortcut No',
      'Ran Yes',
    ]);
  });

  it('starts with nothing selected, the first row the tab stop', () => {
    const timeline = createTimeline(EVENTS);
    expect(timeline.current).toBe(-1);
    expect(marked(timeline.element)).toEqual([]);
    expect(rows(timeline.element).map((row) => row.tabIndex)).toEqual([0, -1, -1, -1, -1]);
  });

  it('setCurrent marks one row, keeps current live, clamps and tells its listeners', () => {
    const timeline = createTimeline(EVENTS);
    const heard = vi.fn();
    timeline.onChange(heard);
    timeline.setCurrent(2);
    expect(timeline.current).toBe(2);
    expect(marked(timeline.element)).toEqual([2]);
    expect(rows(timeline.element)[2]!.tabIndex).toBe(0);
    timeline.setCurrent(3);
    expect(marked(timeline.element)).toEqual([3]);
    expect(heard.mock.calls).toEqual([[2], [3]]);
    timeline.setCurrent(99);
    expect(timeline.current).toBe(4);
    timeline.setCurrent(-7);
    expect(timeline.current).toBe(-1);
    expect(marked(timeline.element)).toEqual([]);
    // With nothing selected, the tab stop goes back to the first row.
    expect(rows(timeline.element)[0]!.tabIndex).toBe(0);
    expect(heard.mock.calls.at(-1)).toEqual([-1]);
  });

  it('selects a row when it is clicked', () => {
    const timeline = createTimeline(EVENTS);
    rows(timeline.element)[3]!
      .querySelector('.ev-name')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(timeline.current).toBe(3);
    expect(marked(timeline.element)).toEqual([3]);
  });

  it('moves with Arrow Down, Arrow Up, Home and End, staying at either end', () => {
    const timeline = createTimeline(EVENTS);
    const root = timeline.element;
    // From none, either arrow selects the first row.
    expect(key(root, 'ArrowDown').defaultPrevented).toBe(true);
    expect(timeline.current).toBe(0);
    timeline.setCurrent(-1);
    key(root, 'ArrowUp');
    expect(timeline.current).toBe(0);
    // Arrow Up stays on the first row; it never clears the selection.
    key(root, 'ArrowUp');
    expect(timeline.current).toBe(0);
    key(root, 'ArrowDown');
    key(root, 'ArrowDown');
    expect(timeline.current).toBe(2);
    expect(key(root, 'End').defaultPrevented).toBe(true);
    expect(timeline.current).toBe(4);
    key(root, 'ArrowDown');
    expect(timeline.current).toBe(4);
    expect(key(root, 'Home').defaultPrevented).toBe(true);
    expect(timeline.current).toBe(0);
    expect(marked(root)).toEqual([0]);
    // Other keys pass through.
    expect(key(root, 'PageDown').defaultPrevented).toBe(false);
    expect(timeline.current).toBe(0);
  });

  it('moves focus with the selection when it is on the page', () => {
    const timeline = createTimeline(EVENTS);
    document.body.append(timeline.element);
    key(timeline.element, 'End');
    expect(document.activeElement).toBe(rows(timeline.element)[4]);
    timeline.element.remove();
  });
});
