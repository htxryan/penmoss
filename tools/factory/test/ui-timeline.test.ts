import { describe, expect, it } from 'vitest';
import { view } from './ui-fixture.ts';

describe("today's slots (A1233)", () => {
  it('draws each run on its slot, coloured by how it ended', () => {
    const lane = (slot: number) =>
      view.timeline.lanes.find((l) => l.slot === slot)?.bars.map((b) => [b.key, b.tone]);
    expect(lane(1)).toEqual([
      ['PEN-72', 'done'],
      ['PEN-75', 'stop'],
      ['PEN-84', 'stop'],
      ['PEN-79', 'live'],
    ]);
    expect(lane(2)).toEqual([
      ['PEN-73', 'stop'],
      ['PEN-74', 'done'],
      ['PEN-77', 'you'],
    ]);
  });

  it('totals the window', () => {
    expect(view.totals).toEqual({ started: 7, inReview: 2, merged: 0, blocked: 3 });
  });
});
