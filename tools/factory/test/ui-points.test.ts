import { describe, expect, it } from 'vitest';
import { pointsOf } from '../src/ui/points.ts';
import { view, card } from './ui-fixture.ts';

describe("the plan's open points, asked once each", () => {
  const q = (text: string, ...options: string[]) => ({ text, options });

  it('pairs each question with its open point when the planner wrote both lists', () => {
    expect(card(view, 'PEN-78').points).toEqual([
      {
        text: 'Include attachments?',
        context: 'Proposed: attachments go in the zip beside their notes. OK?',
        options: [
          {
            value: 'Yes, beside their notes (proposed)',
            label: 'Yes, beside their notes',
            proposed: true,
          },
          { value: 'No', label: 'No', proposed: false },
        ],
      },
      {
        text: 'One zip or one per folder?',
        context: 'Proposed: one zip for the whole library, with its folders kept. OK?',
        options: [
          {
            value: 'One zip, folders kept (proposed)',
            label: 'One zip, folders kept',
            proposed: true,
          },
          { value: 'One zip per folder', label: 'One zip per folder', proposed: false },
        ],
      },
    ]);
    expect(card(view, 'PEN-78').notes).toEqual([]);
  });

  it('takes the first option as the proposal when none is marked', () => {
    expect(
      pointsOf(['A?'], [q('A?', 'Yes', 'No')]).points[0]?.options.map((o) => o.proposed),
    ).toEqual([true, false]);
  });

  it('asks a point with no options as a question of its own, when the rest repeat their points', () => {
    expect(
      pointsOf(['Include attachments?', 'Zip name?'], [q('Include attachments?', 'Yes', 'No')]),
    ).toEqual({
      points: [
        expect.objectContaining({ text: 'Include attachments?', context: null }),
        { text: 'Zip name?', context: null, options: [] },
      ],
      notes: [],
    });
  });

  it("shows points it can't pair once, as notes, rather than twice", () => {
    const { points, notes } = pointsOf(
      ['Proposed: attachments beside notes. OK?', 'Proposed: one zip. OK?'],
      [q('Include attachments?', 'Yes', 'No')],
    );
    expect(points.map((p) => [p.text, p.context])).toEqual([['Include attachments?', null]]);
    expect(notes).toEqual(['Proposed: attachments beside notes. OK?', 'Proposed: one zip. OK?']);
  });
});
