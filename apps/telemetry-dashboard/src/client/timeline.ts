/**
 * One session's timeline (PEN-173): its events in seq order, split into stretches by screen, and
 * the one event selected. Everything is drawn from one list, `events`, and the selection is one
 * index, `current`, changed only by `setCurrent`, so a caller (PEN-178's Play) can drive it: call
 * setCurrent with the next index and listen with onChange.
 */
import {
  eventName,
  gap,
  kindName,
  propsInWords,
  sinceStart,
  stretches,
  type PropValue,
} from './names';

/** One event as /api/session gives it. */
export interface TimelineEvent {
  readonly seq: number;
  readonly at: number;
  readonly client: string;
  readonly actor: string;
  readonly version: string;
  readonly channel: string;
  readonly os: string;
  readonly os_version: string;
  readonly size_class: string | null;
  readonly kind: string;
  readonly name: string;
  readonly props: Readonly<Record<string, PropValue>>;
}

export interface Timeline {
  /** The session's events in seq order: every row, stretch and table row comes from it. */
  readonly events: readonly TimelineEvent[];
  /** The timeline's body; each event's row carries data-index, its place in `events`. */
  readonly element: HTMLElement;
  /** The selected event's index, or -1 for none. Always live. */
  readonly current: number;
  /**
   * Selects the event at `index`, clamped to -1 … events.length − 1 (-1 clears the selection),
   * and tells the listeners. It never scrolls.
   */
  setCurrent(index: number): void;
  /** Calls `listener` with the new index after each change. */
  onChange(listener: (index: number) => void): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

/** An event's display name, its id muted under it. */
function nameCell(event: TimelineEvent): HTMLElement {
  const { title, id } = eventName(`${event.kind}:${event.name}`);
  return element('span', 'ev-name', title, element('span', 'cell-id', id));
}

/** An event's props as label and value chips. */
function chips(event: TimelineEvent): HTMLElement {
  const list = element('ul', 'prop-chips');
  for (const { label, value } of propsInWords(event.kind, event.props)) {
    list.append(
      element(
        'li',
        'prop-chip',
        element('span', 'prop-label', label),
        ' ',
        element('span', 'prop-value', value),
      ),
    );
  }
  return list;
}

/** Each event's time since the session started, and since the event before. */
export function timesOf(events: readonly TimelineEvent[]): { since: string; gap: string }[] {
  const start = Math.min(...events.map((e) => e.at));
  return events.map((event, i) => ({
    since: sinceStart(event.at - start),
    gap: i === 0 ? '' : gap(event.at - events[i - 1]!.at),
  }));
}

export function createTimeline(events: readonly TimelineEvent[]): Timeline {
  const root = element('div', 'timeline');
  root.setAttribute('aria-label', 'Events in Order');
  const cols = element(
    'div',
    'ev ev-cols',
    ...['Since Start', 'Gap', 'Kind', 'Event', 'Details'].map((label) =>
      element('span', '', label),
    ),
  );
  cols.setAttribute('aria-hidden', 'true');
  root.append(cols);
  const times = timesOf(events);
  const rows: HTMLLIElement[] = [];
  stretches(events).forEach((stretch, k) => {
    const section = element('section', 'stretch');
    const title = element('h3', 'stretch-title', stretch.title);
    title.id = `stretch-${k}`;
    if (stretch.id) title.append(' ', element('span', 'cell-id', stretch.id));
    section.setAttribute('aria-labelledby', title.id);
    const head = element(
      'header',
      'stretch-head',
      title,
      element('p', 'stretch-summary', stretch.summary),
    );
    const list = element('ol', 'ev-list');
    for (let index = stretch.first; index < stretch.end; index++) {
      const event = events[index]!;
      const row = element(
        'li',
        'ev',
        element('span', 'ev-since', times[index]!.since),
        element('span', 'ev-gap', times[index]!.gap),
        element('span', 'ev-kind', kindName(`${event.kind}:${event.name}`)),
        nameCell(event),
        chips(event),
      );
      row.dataset['index'] = String(index);
      row.tabIndex = index === 0 ? 0 : -1;
      rows.push(row);
      list.append(row);
    }
    section.append(head, list);
    root.append(section);
  });

  let current = -1;
  const listeners: ((index: number) => void)[] = [];
  const setCurrent = (index: number) => {
    const next = Math.max(-1, Math.min(Math.trunc(index), events.length - 1));
    if (Number.isNaN(next)) return;
    rows[current]?.removeAttribute('aria-current');
    current = next;
    rows.forEach((row, i) => (row.tabIndex = i === (current < 0 ? 0 : current) ? 0 : -1));
    rows[current]?.setAttribute('aria-current', 'true');
    for (const listener of listeners) listener(current);
  };

  root.addEventListener('click', (event) => {
    const row = (event.target as Element).closest<HTMLElement>('li.ev');
    if (row && root.contains(row)) setCurrent(Number(row.dataset['index']));
  });
  root.addEventListener('keydown', (event) => {
    if (events.length === 0) return;
    const last = events.length - 1;
    const moves: Record<string, () => number> = {
      ArrowDown: () => (current < 0 ? 0 : Math.min(current + 1, last)),
      ArrowUp: () => (current < 0 ? 0 : Math.max(current - 1, 0)),
      Home: () => 0,
      End: () => last,
    };
    const move = moves[event.key];
    if (!move || event.altKey || event.ctrlKey || event.metaKey) return;
    // The browser's own scrolling (a line, the whole page) never runs for these keys.
    event.preventDefault();
    setCurrent(move());
    const row = rows[current];
    row?.focus({ preventScroll: true });
    // The rows' scroll margin is the pinned heading's height, so a row under it counts as out
    // of view and comes down to just below it.
    row?.scrollIntoView({ block: 'nearest' });
  });

  return {
    events,
    element: root,
    get current() {
      return current;
    },
    setCurrent,
    onChange(listener) {
      listeners.push(listener);
    },
  };
}
