// @vitest-environment happy-dom
// Playback's words (PEN-178): the As Recorded list says in words what the frame shows, and the
// card's notices say when a session was recorded before what it lacks.
import { describe, expect, it } from 'vitest';
import { notices, recordedLines } from '../../src/client/replay/player';
import { createReplay } from '../../src/client/replay/state';
import { FIXTURE_SESSIONS, timelineEvents } from '../fixtures/sessions';

const mac = createReplay(timelineEvents(FIXTURE_SESSIONS.mac));
const older = createReplay(timelineEvents(FIXTURE_SESSIONS.older));
const android = createReplay(timelineEvents(FIXTURE_SESSIONS.android));
const words = (replay: typeof mac, t: number, variant: 'light' | 'dark' = 'light') =>
  Object.fromEntries(
    recordedLines(replay, replay.frameAt(t), variant).map((line) => [
      line.label,
      line.sub ? `${line.value} (${line.sub})` : line.value,
    ]),
  );

describe('As Recorded', () => {
  it('says what the frame shows, and what was not recorded', () => {
    expect(words(mac, 0, 'dark')).toEqual({
      Event: 'Launch (app:launch · 1 of 81)',
      Screen: 'Before Any Screen',
      Window: '1,280 × 800 (Not Recorded)',
      Sidebar: 'Shown, 272 px (Not Recorded)',
      Theme: 'Penmoss, System (Drawn Dark) (Theme Not Recorded)',
      Dialog: 'None',
    });
    expect(words(mac, 24_000)).toMatchObject({
      Screen: 'Note',
      Sidebar: 'Rail',
      'Note Panel': 'Open on Metadata',
      Tabs: '2–4 (Drawn as 2)',
      Theme: 'Penmoss, Dark (Theme Not Recorded)',
      Dialog: 'Command Palette (10 Characters Typed)',
      Scroll: 'Note 12%',
    });
    expect(words(mac, 30_000)).toMatchObject({
      Screen: 'Settings › Appearance',
      Sidebar: 'Rail (Not on This Screen)',
      Scroll: 'Settings 42%',
    });
    expect(words(mac, 301_000)).toMatchObject({ Selection: '230 Characters across 2 Blocks' });
    expect(words(mac, 346_000)).toMatchObject({ Theme: 'Solarized, Dark', 'Full Width': 'Yes' });
  });

  it('says Placeholder for a note whose shape was not recorded', () => {
    expect(words(older, 10_000)).toMatchObject({ Note: 'Placeholder' });
    expect(words(mac, 3300)).toMatchObject({ Note: 'Placeholder (Shape Not Recorded)' });
  });

  it('shows no tab count for Android', () => {
    expect(words(android, 10_000)).not.toHaveProperty('Tabs');
  });
});

describe('the notices', () => {
  it('say a session was recorded before shape and typing, and its window', () => {
    expect(notices(older, 'mac')).toEqual([
      "This session was recorded before Penmoss recorded a note's shape and typing, so its notes play as placeholders. Its window's size and layout weren't recorded either: it plays in an expanded window as the app first opens.",
    ]);
    expect(notices(mac, 'mac')).toEqual([]);
  });

  it("say an Android session is drawn with the app's phone layout", () => {
    expect(notices(android, 'android')).toEqual([
      "An Android session is drawn with the app's phone layout, as the web app shows it on a phone: Android's own screens differ in places.",
    ]);
  });
});
