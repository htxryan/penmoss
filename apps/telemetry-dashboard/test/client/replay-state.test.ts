// A session's replay state (PEN-178): the Frame at any moment of a recorded session, from its
// events alone, over the recorded fixtures (test/fixtures). Seeking to a moment and playing up to
// it give the same frame; a note's shape follows core's rules (replayShape).
import { eventProblem, replayShape } from '@penmoss/core/analytics';
import { describe, expect, it } from 'vitest';
import { duration } from '../../src/client/names';
import {
  createReplay,
  skipFrom,
  type Frame,
  type ReplayEvent,
} from '../../src/client/replay/state';
import { FIXTURE_SESSIONS, analyticsEvents, timelineEvents } from '../fixtures/sessions';

const mac = timelineEvents(FIXTURE_SESSIONS.mac);
const replay = createReplay(mac);
const at = (seconds: number, options = {}) => replay.frameAt(seconds * 1000, options);
const tokens = (frame: Frame) => frame.note?.blocks?.map((b) => b.token) ?? null;
const lengthOf = (frame: Frame, block: number) => frame.note?.blocks?.[block]?.length;

describe('the recorded fixtures', () => {
  it('are events the apps send: every one passes eventProblem', () => {
    for (const [name, fixture] of Object.entries(FIXTURE_SESSIONS)) {
      for (const event of analyticsEvents(fixture, 1_790_000_000_000)) {
        expect(eventProblem(event), `${name} ${event.seq} ${event.kind}:${event.name}`).toBeNull();
      }
    }
  });
});

describe('the window and the layout', () => {
  it('draws the recorded main window, or the size class’s before one is recorded', () => {
    expect(at(0).window).toEqual({ width: 1280, height: 800, recorded: false });
    expect(at(0.3).window).toEqual({ width: 1440, height: 900, recorded: true });
    expect(at(0.3).sizeClass).toBe('expanded');
  });

  it('takes each app layout: the sidebar and its width, the panel, full width, the mode, tabs', () => {
    expect(at(0).layout).toMatchObject({
      sidebar: 'shown',
      sidebarWidth: 272,
      panel: 'closed',
      recorded: false,
    });
    expect(at(0.4).layout).toMatchObject({
      sidebar: 'shown',
      sidebarWidth: 280,
      fullWidth: false,
      themeMode: 'light',
      tabs: '2–4',
      recorded: true,
    });
    expect(at(5).layout.panel).toBe('open');
    expect(at(18.1).layout).toMatchObject({ sidebar: 'rail', sidebarWidth: null });
    expect(at(20.1).layout.themeMode).toBe('dark');
    expect(at(345.1).layout.fullWidth).toBe(true);
  });

  it('takes the theme from the last setting theme.id, none before one', () => {
    expect(at(341).theme).toBeNull();
    expect(at(342).theme).toBe('solarized');
    expect(at(1084).theme).toBe('solarized');
  });
});

describe('screens, dialogs and scrolling', () => {
  it('shows each screen as it is recorded', () => {
    expect(at(0).screen).toBeNull();
    expect(at(1).screen).toBe('home');
    expect(at(26.4).screen).toBe('settings.appearance');
    expect(at(320.2).screen).toBe('tags');
  });

  it('opens a dialog until its Done or Cancel, and fills its field to the recorded length', () => {
    expect(at(22.1).dialogs).toEqual([{ name: 'palette', field: null, chars: null }]);
    expect(at(23).dialogs).toEqual([{ name: 'palette', field: 'query', chars: 3 }]);
    expect(at(24).dialogs[0]?.chars).toBe(10);
    expect(at(26).dialogs).toEqual([]);
    expect(at(323).dialogs).toEqual([{ name: 'confirm', field: 'name', chars: 6 }]);
    expect(at(325).dialogs).toEqual([]);
  });

  it('stacks a dialog opened inside another; closing it shows the one under it', () => {
    const base = mac[0]!;
    const stacked = createReplay([
      base,
      {
        ...base,
        seq: 1,
        at: base.at + 1000,
        kind: 'dialog',
        name: 'palette',
        props: { action: 'open' },
      },
      {
        ...base,
        seq: 2,
        at: base.at + 2000,
        kind: 'input',
        name: 'palette',
        props: { field: 'query', chars: 4 },
      },
      {
        ...base,
        seq: 3,
        at: base.at + 3000,
        kind: 'dialog',
        name: 'confirm',
        props: { action: 'open' },
      },
      {
        ...base,
        seq: 4,
        at: base.at + 4000,
        kind: 'dialog',
        name: 'confirm',
        props: { action: 'cancel' },
      },
      {
        ...base,
        seq: 5,
        at: base.at + 5000,
        kind: 'input',
        name: 'settingsSearch',
        props: { field: 'query', chars: 5 },
      },
    ]);
    expect(stacked.frameAt(3000).dialogs.map((d) => d.name)).toEqual(['palette', 'confirm']);
    expect(stacked.frameAt(4000).dialogs).toEqual([{ name: 'palette', field: 'query', chars: 4 }]);
    // An input whose name isn't a dialog fills that screen's field: Settings' search (A1666).
    expect(stacked.frameAt(5000).settingsSearch).toBe(5);
  });

  it('scrolls each area to its position, and a new screen starts at the top', () => {
    expect(at(2).scroll).toEqual({ sidebar: 0.18 });
    expect(at(30).scroll).toEqual({ settings: 0.42 });
    expect(at(31).scroll).toEqual({ settings: 0.42, 'settings.nav': 0.25 });
    expect(at(33).scroll).toEqual({});
  });
});

describe('the note', () => {
  it('draws a note screen as placeholders until its note open, then its recorded shape', () => {
    expect(at(3.3).note).toMatchObject({ blocks: null, title: null });
    expect(at(3.3).placeholders).toBe(false);
    const open = at(3.6);
    expect(tokens(open)).toEqual(FIXTURE_SESSIONS.mac.events[7]!.props['shape']);
    expect(open.note?.title?.length).toBe(24);
  });

  it('spreads a typing burst over the second before its event, deleting first', () => {
    expect(lengthOf(at(6), 3)).toBe(31);
    // Typed 6 over 6.0–7.0: half way, 3.
    expect(lengthOf(at(6.5), 3)).toBe(34);
    expect(lengthOf(at(7), 3)).toBe(37);
    // Typed 5, deleted 2 over 8.0–9.0, from 44: the 2 go first, then the 5 arrive.
    expect(lengthOf(at(8.2), 3)).toBe(43);
    expect(lengthOf(at(8.3), 3)).toBe(42);
    expect(lengthOf(at(8.9), 3)).toBe(46);
    expect(lengthOf(at(9), 3)).toBe(47);
    // The caret is at the block typed in.
    expect(at(8.5).note?.caret).toBe(3);
  });

  it('gives the block its new length in one step under Reduce Motion', () => {
    expect(lengthOf(at(6.5, { reduceMotion: true }), 3)).toBe(31);
    expect(lengthOf(at(7, { reduceMotion: true }), 3)).toBe(37);
  });

  it('splices blocks in: a new block starts empty with a lorem seed of its own', () => {
    const before = at(11.4);
    const after = at(11.5);
    expect(after.note?.blocks).toHaveLength(before.note!.blocks!.length + 1);
    expect(after.note?.blocks?.[4]).toMatchObject({ token: 'li.b.1:0', length: 0 });
    const seeds = after.note!.blocks!.map((b) => b.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
    // The blocks after it keep their seeds: their text doesn't change.
    expect(after.note?.blocks?.[5]?.seed).toBe(before.note?.blocks?.[4]?.seed);
  });

  it('moves the caret, highlights a selection, and a remote edit never moves the caret', () => {
    expect(at(298).note?.caret).toBe(0);
    expect(at(300).note).toMatchObject({
      caret: null,
      selection: { block: 1, chars: 230, span: 2 },
    });
    expect(at(306).note).toMatchObject({ caret: 8, selection: null });
    const remote = at(312);
    expect(lengthOf(remote, 2)).toBe((lengthOf(at(311), 2) ?? 0) + 9);
    expect(remote.note?.caret).toBe(8);
  });

  it('types in the title', () => {
    expect(at(357).note?.title?.length).toBe(30);
    expect(at(357).note?.caret).toBe('title');
  });

  it('brings a note back as it was when the session switches back to it', () => {
    const a = at(349);
    const b = at(352);
    expect(b.note?.ref).toBe('b2c3d4e5f6071829');
    expect(tokens(b)).toEqual(['h2:12', 'p:52']);
    const back = at(355);
    expect(back.note?.ref).toBe('a1b2c3d4e5f60718');
    expect(tokens(back)).toEqual(tokens(a));
  });

  it("ends with the shape core's replayShape gives", () => {
    const events = FIXTURE_SESSIONS.mac.events;
    const lastOpen = events.findLastIndex(
      (e) => e.kind === 'note' && e.name === 'open' && e.props['how'] === 'open',
    );
    const shape = replayShape(
      events[lastOpen]!.props as never,
      events
        .slice(lastOpen + 1)
        .map((e) => ({ kind: e.kind, name: e.name, props: e.props as never })),
    );
    expect(tokens(at(1084))).toEqual(shape);
  });
});

describe('seeking and playing', () => {
  it('gives the same frame seeking to a moment as playing up to it, at every event and between', () => {
    const playing = createReplay(mac);
    const moments: number[] = [];
    replay.times.forEach((time, i) => {
      moments.push(time);
      const next = replay.times[i + 1];
      if (next !== undefined) moments.push((time + next) / 2);
    });
    for (const moment of moments) {
      const sought = createReplay(mac).frameAt(moment);
      expect(playing.frameAt(moment), `at ${moment}`).toEqual(sought);
    }
  });

  it('keeps snapshots so a long session seeks from the nearest', () => {
    const base = mac[0]!;
    const long: ReplayEvent[] = [base];
    for (let i = 1; i < 1200; i++) {
      long.push({
        ...base,
        seq: i,
        at: base.at + i * 500,
        kind: 'scroll',
        name: 'note',
        props: { position: (i % 100) / 100 },
      });
    }
    const big = createReplay(long);
    expect(big.frameAt(599_500).scroll).toEqual({ note: 0.99 });
    expect(big.frameAt(100_000).scroll).toEqual({ note: 0 });
    expect(big.frameAt(100_000)).toEqual(createReplay(long).frameAt(100_000));
  });

  it('marks the last event at or before the moment, or the one chosen when several share it', () => {
    expect(at(22.05).current).toBe(24);
    expect(replay.events[24]?.name).toBe('app.palette');
    expect(at(22.1).current).toBe(25);
    expect(replay.frameAt(22_100, { index: 25 }).current).toBe(25);
  });

  it('skips a pause of more than 10 seconds to 1 second before the next event', () => {
    const skipped = skipFrom(replay, 45_000);
    expect(skipped).toEqual({ to: 297_000, skipped: 252_000 });
    expect(duration(skipped!.skipped)).toBe('4m 12s');
    // A gap of 10 seconds or less plays in full.
    expect(skipFrom(replay, 26_400)).toBeNull();
  });
});

describe('older and thinner sessions', () => {
  it('plays a session from before PEN-174 and PEN-177 with placeholders and the defaults', () => {
    const older = createReplay(timelineEvents(FIXTURE_SESSIONS.older));
    expect(older.beforeDetail).toBe(true);
    expect(older.beforeLayout).toBe(true);
    const frame = older.frameAt(10_000);
    expect(frame.screen).toBe('note');
    expect(frame.placeholders).toBe(true);
    expect(frame.note).toMatchObject({ blocks: null, title: null });
    expect(frame.window).toEqual({ width: 1280, height: 800, recorded: false });
    expect(frame.layout).toMatchObject({ sidebar: 'shown', panel: 'closed', recorded: false });
  });

  it('plays an Android session at its size, with no tabs', () => {
    const android = createReplay(timelineEvents(FIXTURE_SESSIONS.android));
    expect(android.beforeDetail).toBe(false);
    expect(android.beforeLayout).toBe(false);
    const home = android.frameAt(1000);
    expect(home.window).toEqual({ width: 410, height: 920, recorded: true });
    expect(home.layout).toMatchObject({ sidebar: 'hidden', tabs: null });
    expect(android.frameAt(3000).layout.sidebar).toBe('shown');
    expect(tokens(android.frameAt(10_000))).toEqual([
      'h1:18',
      'p:153',
      'li.t.1:20',
      'li.t.1:16',
      'p:60',
    ]);
  });
});
