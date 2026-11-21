/**
 * Playback (PEN-178): a session's page plays the session back as the app looked. One list of
 * events drives the timeline, the frame and the As Recorded list, and the frame is redrawn from
 * `replay.frameAt(t)` alone, so seeking and playing agree. The clock is requestAnimationFrame at
 * 1×, 2× or 4×; a pause of more than 10 seconds plays as 1 second (O4). While it plays the card
 * sticks to the top of the window and the page keeps the played row in view below it (O3), until
 * a scroll by hand. The frame is player.html in a same-origin iframe, which draws what it's sent.
 */
import { BUILT_IN_THEMES } from '@penmoss/ui/theme';
import { node } from '../dom';
import { displayName, duration, eventName, sinceStart, titled } from '../names';
import type { Timeline, TimelineEvent } from '../timeline';
import type { FrameMessage } from './frame-draw';
import {
  bucketFloor,
  createReplay,
  isNoteScreen,
  NARROW_PX,
  skipFrom,
  type Frame,
  type Replay,
} from './state';

/** The speeds, in order. */
export const SPEEDS = [1, 2, 4] as const;
/** How long "Skipped a … Pause" shows. */
const SKIP_SHOWN_MS = 2000;
/** The frame is at most this share of the window's height (O3). */
const FRAME_HEIGHT_SHARE = 0.5;
/** The card sticks only when it is no taller than this share of the window, and the window is wide. */
const STICKY_HEIGHT_SHARE = 0.7;
const STICKY_MIN_WIDTH = 600;
/** The As Recorded list's narrowest beside the stage, and the stage's narrowest beside it. */
const LIST_MIN_PX = 240;
const STAGE_MIN_PX = 340;

const SIZE_CLASS_WORDS = { compact: 'compact', medium: 'medium', expanded: 'expanded' } as const;

/** The notices over the frame for an older session and for Android (ac5, ac6). */
export function notices(replay: Replay, client: string): string[] {
  const out: string[] = [];
  if (replay.beforeDetail) {
    let line =
      "This session was recorded before Penmoss recorded a note's shape and typing, so its notes play as placeholders.";
    if (replay.beforeLayout) {
      line += ` Its window's size and layout weren't recorded either: it plays in ${replay.sizeClass === 'expanded' ? 'an' : 'a'} ${SIZE_CLASS_WORDS[replay.sizeClass]} window as the app first opens.`;
    }
    out.push(line);
  } else if (replay.beforeLayout) {
    out.push(
      `This session's window size and layout weren't recorded: it plays in ${replay.sizeClass === 'expanded' ? 'an' : 'a'} ${SIZE_CLASS_WORDS[replay.sizeClass]} window as the app first opens.`,
    );
  }
  if (client === 'android') {
    out.push(
      "An Android session is drawn with the app's phone layout, as the web app shows it on a phone: Android's own screens differ in places.",
    );
  }
  return out;
}

/** A block's kind in words, from its recorded token (`h1:24` is "Heading 1"). */
const BLOCK_KINDS: Readonly<Record<string, string>> = {
  p: 'Paragraph',
  'li.b': 'Bulleted Item',
  'li.n': 'Numbered Item',
  'li.t': 'Checklist Item',
  quote: 'Quote',
  code: 'Code Block',
  callout: 'Callout',
  math: 'Math',
  raw: 'Raw',
  table: 'Table',
  image: 'Image',
  embed: 'Embed',
  file: 'File',
  drawing: 'Drawing',
  hr: 'Divider',
  other: 'Other',
};
export function blockKind(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const heading = token.match(/^h([1-6])\b/);
  if (heading) return `Heading ${heading[1]}`;
  const kind = token.split(':')[0]!;
  return BLOCK_KINDS[kind.startsWith('li.') ? kind.slice(0, 4) : kind.split('.')[0]!];
}

const count = (n: number) => n.toLocaleString('en-GB');
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** One line of the As Recorded list: its label, its value and a muted line under it. */
export interface RecordedLine {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
}

const THEME_NAMES = new Map(BUILT_IN_THEMES.map((theme) => [theme.id, theme.name]));
const SCROLL_WORDS: Readonly<Record<string, string>> = {
  note: 'Note',
  sidebar: 'Sidebar',
  'sidebar.folders': 'Folders',
  'sidebar.recent': 'Recent Notes',
  'sidebar.tags': 'Tags',
  settings: 'Settings',
  'settings.nav': 'List of Pages',
};

/**
 * Where the player opens and Play starts again: the last event of the session's first moment, the
 * events the timeline lists at its first Since Start (the launch, the window, the layout…), so the
 * first frame is drawn at the recorded window's size and layout, as the timeline's first rows say.
 */
export function openingIndex(replay: Pick<Replay, 'times'>): number {
  const { times } = replay;
  if (times.length === 0) return -1;
  const first = sinceStart(times[0]!);
  let i = 0;
  while (i + 1 < times.length && sinceStart(times[i + 1]!) === first) i++;
  return i;
}

/** What the frame shows, in words: the frame's words for a screen reader, and what tests read. */
export function recordedLines(
  replay: Replay,
  frame: Frame,
  variant: 'light' | 'dark',
): RecordedLine[] {
  const lines: RecordedLine[] = [];
  const event = replay.events[frame.current] as TimelineEvent | undefined;
  if (event) {
    const name = eventName(`${event.kind}:${event.name}`);
    lines.push({
      label: 'Event',
      value: name.title,
      sub: `${name.id} · ${count(frame.current + 1)} of ${count(replay.events.length)}`,
    });
  }
  const screen = frame.screen;
  const onNote = isNoteScreen(screen);
  const onSettings = screen?.startsWith('settings') ?? false;
  lines.push({
    label: 'Screen',
    // The app opens on Home, so that's what's drawn before the first screen event.
    ...(screen
      ? { value: displayName('screen', screen) }
      : { value: 'Home', sub: 'Before Any Screen' }),
  });
  lines.push({
    label: 'Window',
    value: `${count(frame.window.width)} × ${count(frame.window.height)}`,
    ...(frame.window.recorded ? {} : { sub: 'Not Recorded' }),
  });
  const phone = frame.window.width <= NARROW_PX;
  const { layout } = frame;
  const sidebarValue =
    layout.sidebar === 'shown'
      ? phone
        ? 'Drawer Open'
        : `Shown, ${count(layout.sidebarWidth ?? 0)} px`
      : layout.sidebar === 'rail'
        ? 'Rail'
        : phone
          ? 'Drawer Closed'
          : 'Hidden';
  lines.push({
    label: 'Sidebar',
    value: sidebarValue,
    ...(!layout.recorded
      ? { sub: 'Not Recorded' }
      : onSettings
        ? { sub: 'Not on This Screen' }
        : {}),
  });
  if (onNote) {
    lines.push({
      label: 'Note Panel',
      value: layout.panel === 'open' ? 'Open on Metadata' : 'Closed',
      ...(layout.recorded ? {} : { sub: 'Not Recorded' }),
    });
    if (layout.fullWidth) lines.push({ label: 'Full Width', value: 'Yes' });
    if (layout.tabs !== null) {
      const drawn = Math.max(1, bucketFloor(layout.tabs) ?? 1);
      lines.push({
        label: 'Tabs',
        value: layout.tabs,
        ...(layout.recorded
          ? String(drawn) === layout.tabs
            ? {}
            : { sub: `Drawn as ${drawn}` }
          : { sub: 'Not Recorded' }),
      });
    }
  }
  const mode =
    layout.themeMode === 'system'
      ? `System (Drawn ${variant === 'dark' ? 'Dark' : 'Light'})`
      : titled(layout.themeMode);
  const theme =
    frame.theme === null
      ? 'Penmoss'
      : frame.theme === 'custom'
        ? 'Custom (Drawn as Penmoss)'
        : (THEME_NAMES.get(frame.theme) ?? titled(frame.theme));
  lines.push({
    label: 'Theme',
    value: `${theme}, ${mode}`,
    ...(frame.theme === null ? { sub: 'Theme Not Recorded' } : {}),
  });
  lines.push({
    label: 'Dialog',
    value:
      frame.dialogs.length === 0
        ? 'None'
        : frame.dialogs.map((dialog) => displayName('dialog', dialog.name)).join(' › '),
    ...(frame.dialogs.at(-1)?.chars
      ? { sub: `${plural(frame.dialogs.at(-1)!.chars!, 'Character')} Typed` }
      : {}),
  });
  if (onNote) {
    const note = frame.note;
    if (!note || note.blocks === null) {
      lines.push({
        label: 'Note',
        value: 'Placeholder',
        ...(frame.placeholders ? {} : { sub: 'Shape Not Recorded' }),
      });
    } else {
      const chars = note.blocks.reduce((sum, b) => sum + (b.length ?? 0), 0);
      lines.push({
        label: 'Note',
        value: `${plural(note.blocks.length, 'Block')}, ${plural(chars, 'Character')}`,
        sub: `Title ${plural(note.title?.length ?? 0, 'Character')}${note.more ? ' · Cut at the Cap' : ''}`,
      });
    }
    // A block is numbered as recorded, from 0, as the timeline's Block chip numbers it.
    if (note?.selection) {
      lines.push({
        label: 'Selection',
        value: `${plural(note.selection.chars, 'Character')} across ${plural(note.selection.span, 'Block')}`,
        sub: `From Block ${count(note.selection.block)}`,
      });
    } else if (note?.caret !== null && note?.caret !== undefined) {
      const kind = note.caret === 'title' ? undefined : blockKind(note.blocks?.[note.caret]?.token);
      lines.push({
        label: 'Caret',
        value: note.caret === 'title' ? 'In the Title' : `At the End of Block ${count(note.caret)}`,
        ...(kind ? { sub: kind } : {}),
      });
    }
  }
  const scrolled = Object.entries(frame.scroll);
  if (scrolled.length > 0) {
    lines.push({
      label: 'Scroll',
      value: scrolled
        .map(
          ([area, position]) =>
            `${SCROLL_WORDS[area] ?? titled(area)} ${Math.round(position * 100)}%`,
        )
        .join(', '),
    });
  }
  return lines;
}

/** "4:12 / 18:04". */
const clock = (t: number, total: number) => `${sinceStart(t)} / ${sinceStart(total)}`;

export interface Player {
  /** The Playback card. */
  readonly element: HTMLElement;
  /** Stops the clock and removes every listener (a re-render). */
  dispose(): void;
}

interface Parts {
  readonly button: (label: string, onClick: () => void, name?: string) => HTMLButtonElement;
  readonly card: (body: HTMLElement, controls: readonly HTMLElement[], note: string) => HTMLElement;
}

/**
 * The Playback card for `events`, driving `timeline`. `wrap` is the element holding the card and
 * the timeline, in which the card sticks while it plays.
 */
export function createPlayer(
  events: readonly TimelineEvent[],
  timeline: Timeline,
  wrap: HTMLElement,
  parts: Parts,
  more: boolean,
): Player {
  const replay = createReplay(events);
  const client = events[0]?.client ?? 'mac';
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
  const variantOf = (frame: Frame): 'light' | 'dark' =>
    frame.layout.themeMode === 'dark'
      ? 'dark'
      : frame.layout.themeMode === 'light'
        ? 'light'
        : systemDark()
          ? 'dark'
          : 'light';

  // The frame: an iframe at the recorded window's size, scaled to fit the stage.
  const iframe = document.createElement('iframe');
  iframe.className = 'pb-frame';
  iframe.src = '/player';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  iframe.inert = true;
  const scaler = node('div', 'pb-scaler', iframe);
  const skip = node('p', 'pb-skip');
  skip.hidden = true;
  const stage = node('div', 'pb-stage', scaler, skip);
  const list = node('dl', 'pb-list');
  list.setAttribute('aria-label', 'As Recorded');
  const spoken = node('p', 'sr-only');
  spoken.setAttribute('role', 'status');
  // The stage is the scaled frame's own width, so the list sits right beside it.
  const body = node('div', 'pb-body', stage, list, spoken);
  const said = notices(replay, client);
  const content = node(
    'div',
    'pb-content',
    ...(said.length > 0
      ? [node('div', 'pb-notices', ...said.map((line) => node('p', 'pb-notice', line)))]
      : []),
    body,
  );

  // The controls, in the card's .tools bar.
  let playing = false;
  let speed: (typeof SPEEDS)[number] = 1;
  const opening = openingIndex(replay);
  const openingTime = opening >= 0 ? replay.times[opening]! : 0;
  let t = timeline.current >= 0 ? replay.times[timeline.current]! : openingTime;
  let pinnedIndex: number | undefined = timeline.current >= 0 ? timeline.current : undefined;
  let ended = false;
  const play = parts.button('Play', () => (playing ? pause() : start()));
  play.classList.add('pb-play');
  const speeds = SPEEDS.map((n) => {
    const b = parts.button(`${n}×`, () => setSpeed(n), `Speed ${n}×`);
    b.classList.add('pb-speed');
    b.setAttribute('aria-pressed', String(n === speed));
    return b;
  });
  const scrubber = document.createElement('input');
  scrubber.type = 'range';
  scrubber.className = 'pb-scrubber';
  scrubber.min = '0';
  scrubber.max = String(Math.ceil(replay.duration / 1000) * 1000);
  scrubber.step = '1000';
  scrubber.setAttribute('aria-label', 'Position');
  const time = node('span', 'pb-time');
  const card = parts.card(
    content,
    [play, ...speeds, node('span', 'pb-scrub', scrubber), time],
    `The session as the app looked, drawn with the app's own stylesheet. Notes are lorem ipsum in the shape that was recorded: no word is ever recorded.${more ? ' Plays the first 5,000 events.' : ''}`,
  );

  // Drawing: the time on every moment, the frame only when it changes. The list says what the
  // frame shows, so once the frame is loaded it's redrawn when the frame says it has drawn that
  // frame, never ahead of it.
  let ready = false;
  let posted = '';
  let seq = 0;
  const awaiting = new Map<number, readonly RecordedLine[]>();
  let lastFrame: Frame | null = null;
  let driving = false;
  const showLines = (lines: readonly RecordedLine[]) =>
    list.replaceChildren(
      ...lines.flatMap((line) => {
        const value = node('dd', '', line.value);
        if (line.sub) value.append(node('span', 'pb-sub', line.sub));
        return [node('dt', '', line.label), value];
      }),
    );
  const draw = () => {
    const frame = replay.frameAt(t, {
      reduceMotion: reduceMotion(),
      ...(pinnedIndex === undefined ? {} : { index: pinnedIndex }),
    });
    lastFrame = frame;
    const variant = variantOf(frame);
    if (timeline.current !== frame.current) {
      driving = true;
      timeline.setCurrent(frame.current);
      driving = false;
      if (playing && following && pinned) keepRowInView(frame.current);
    }
    scrubber.value = String(Math.round(t / 1000) * 1000);
    scrubber.setAttribute('aria-valuetext', `${sinceStart(t)} of ${sinceStart(replay.duration)}`);
    time.textContent = clock(t, replay.duration);
    fit(frame);
    // The frame's time aside: the frame draws the same at every moment of one state.
    const key = JSON.stringify([{ ...frame, t: 0 }, variant]);
    if (!ready) {
      showLines(recordedLines(replay, frame, variant));
    } else if (key !== posted) {
      posted = key;
      seq += 1;
      awaiting.set(seq, recordedLines(replay, frame, variant));
      const message: FrameMessage = { type: 'frame', frame, variant, seq };
      iframe.contentWindow?.postMessage(message, location.origin);
    }
  };

  // The frame's size and scale: the recorded window, at most the room the list leaves beside it
  // (or the card's width, once the list wraps under it) and half the window's height, never
  // above 1.
  let fitted = '';
  const roomFor = () => {
    const style = getComputedStyle(body);
    const inner =
      body.clientWidth -
      parseFloat(style.paddingLeft || '0') -
      parseFloat(style.paddingRight || '0');
    const beside = inner - LIST_MIN_PX - parseFloat(style.columnGap || '0');
    return innerWidth > STICKY_MIN_WIDTH && beside >= STAGE_MIN_PX ? beside : inner;
  };
  const fit = (frame: Frame) => {
    const { width, height } = frame.window;
    const room = roomFor() || width;
    const scale = Math.min(1, room / width, (innerHeight * FRAME_HEIGHT_SHARE) / height);
    const key = `${width}x${height}@${scale}`;
    if (key === fitted) return;
    fitted = key;
    iframe.style.width = `${width}px`;
    iframe.style.height = `${height}px`;
    // The box around the frame is scaled, not the frame alone, so nothing outside the stage
    // keeps the recorded window's full width.
    scaler.style.transform = `scale(${scale})`;
    stage.style.width = `${Math.round(width * scale)}px`;
    stage.style.height = `${Math.round(height * scale)}px`;
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.origin !== location.origin) return;
    const data = event.data as { type?: string; seq?: number } | null;
    if (data?.type === 'drawn' && typeof data.seq === 'number') {
      const lines = awaiting.get(data.seq);
      for (const n of awaiting.keys()) if (n <= data.seq) awaiting.delete(n);
      if (lines) showLines(lines);
      return;
    }
    if (data?.type !== 'ready') return;
    ready = true;
    posted = '';
    draw();
  };
  window.addEventListener('message', onMessage);

  // Sticking and following (O3).
  let pinned = false;
  let following = false;
  const stick = (on: boolean) => {
    const fits =
      innerWidth >= STICKY_MIN_WIDTH && card.offsetHeight <= innerHeight * STICKY_HEIGHT_SHARE;
    pinned = on && fits;
    card.classList.toggle('pb-pinned', pinned);
    wrap.toggleAttribute('data-playing', pinned);
    if (pinned) wrap.style.setProperty('--pb-height', `${card.offsetHeight}px`);
  };
  const keepRowInView = (index: number) => {
    const row = timeline.element.querySelector<HTMLElement>(`li.ev[data-index="${index}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    // A row near the timeline's start can come into view with the card below the window's top:
    // the page goes on down to the card, which leaves the row still below it.
    const top = card.getBoundingClientRect().top;
    if (pinned && top > 0) window.scrollBy(0, top);
  };
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
  const byHand = () => {
    following = false;
    // Stopped, the card stays pinned (in view, with Play) until the page is scrolled by hand.
    if (!playing && pinned) stick(false);
  };
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as Element | null;
    // Keys in a control or the timeline move it, not the page.
    if (target && target !== document.body && target.closest('input, button, select, a, .timeline'))
      return;
    if (SCROLL_KEYS.has(event.key)) byHand();
  };
  window.addEventListener('wheel', byHand, { passive: true });
  window.addEventListener('touchmove', byHand, { passive: true });
  window.addEventListener('keydown', onKey);

  // The clock.
  let frameRequest = 0;
  let lastTick = 0;
  let skipTimer = 0;
  const tick = (now: number) => {
    if (!playing) return;
    const dt = Math.min(250, now - lastTick);
    lastTick = now;
    const skipped = skipFrom(replay, t);
    if (skipped) {
      t = skipped.to;
      const words = `Skipped a ${duration(Math.round(skipped.skipped / 1000) * 1000)} Pause`;
      skip.textContent = words;
      skip.hidden = false;
      spoken.textContent = words;
      clearTimeout(skipTimer);
      skipTimer = window.setTimeout(() => {
        skip.hidden = true;
      }, SKIP_SHOWN_MS);
    } else {
      t += dt * speed;
    }
    pinnedIndex = undefined;
    if (t >= replay.duration) {
      t = replay.duration;
      draw();
      pause();
      ended = true;
      return;
    }
    draw();
    frameRequest = requestAnimationFrame(tick);
  };
  const setLabel = (label: string) => {
    play.textContent = label;
    play.setAttribute('aria-label', label);
  };
  function start() {
    if (ended || t >= replay.duration) {
      t = openingTime;
      pinnedIndex = undefined;
      ended = false;
    }
    playing = true;
    following = true;
    setLabel('Pause');
    stick(true);
    lastTick = performance.now();
    draw();
    if (pinned) keepRowInView(timeline.current);
    cancelAnimationFrame(frameRequest);
    frameRequest = requestAnimationFrame(tick);
  }
  function pause() {
    playing = false;
    cancelAnimationFrame(frameRequest);
    setLabel('Play');
  }
  function setSpeed(n: (typeof SPEEDS)[number]) {
    speed = n;
    speeds.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === n)));
  }
  const seek = (to: number, index?: number) => {
    t = Math.max(0, Math.min(to, replay.duration));
    pinnedIndex = index;
    ended = false;
    draw();
  };
  scrubber.addEventListener('input', () => seek(Number(scrubber.value)));
  timeline.onChange((index) => {
    if (driving || index < 0) return;
    seek(replay.times[index]!, index);
  });
  const onResize = () => {
    if (lastFrame) {
      fitted = '';
      fit(lastFrame);
    }
    if (playing || pinned) stick(true);
  };
  window.addEventListener('resize', onResize);
  const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
  watch?.observe(body);

  draw();
  return {
    element: card,
    dispose() {
      playing = false;
      cancelAnimationFrame(frameRequest);
      clearTimeout(skipTimer);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('wheel', byHand);
      window.removeEventListener('touchmove', byHand);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      watch?.disconnect();
      wrap.removeAttribute('data-playing');
    },
  };
}
