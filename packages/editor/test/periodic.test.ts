import * as core from '@penmoss/core';
import {
  DEFAULT_DAILY_TEMPLATE,
  DEFAULT_TIME_ZONE,
  DEFAULT_WEEKLY_TEMPLATE,
  isoWeek,
  periodicNoteId,
  todayIn,
  type PeriodKind,
} from '@penmoss/core/periodic';
import { readIdentity, readTitle } from '@penmoss/sync-client/note';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import * as Y from '@y/y';
import { afterEach, describe, expect, it } from 'vitest';
import { createCollabEditor } from '../src/collab';
import { noteExtensions } from '../src/extensions';
import { periodicNote } from '../src/periodic';
import fixture from '../../../apps/android/contract/periodic-fixture.json';

const zone = process.env.TZ;
afterEach(() => {
  process.env.TZ = zone;
});

/** One device: its own clock and zone, and its own Yjs client for what it types. */
function device(timeZone: string, now: string, template = DEFAULT_DAILY_TEMPLATE) {
  process.env.TZ = timeZone; // The device's zone: it must not matter.
  const clock = new Date(now);
  // The day comes from the synced setting (America/Chicago by default), not the device.
  const day = todayIn(DEFAULT_TIME_ZONE, clock).toString();
  const note = periodicNote(core, 'daily', day, template);
  const doc = new Y.Doc(); // a random client id, like every device's replica
  Y.applyUpdate(doc, note.update);
  return { note, doc, day, offset: clock.getTimezoneOffset() };
}

const bodyText = (doc: Y.Doc) =>
  JSON.stringify(doc.get(NOTE_ROOT).toDeltaDeep().toJSON()).replace(/"format":\{[^}]*\}/g, '');

describe('periodic notes from templates (T19, A4)', () => {
  it('builds byte-identical updates on two devices in different zones, and merges to one note', () => {
    // 22:10 in Tokyo on the 22nd and 06:10 in Los Angeles on the 21st: both 08:10 in Chicago, the 21st.
    const tokyo = device('Asia/Tokyo', '2026-10-21T13:10:00Z');
    const angeles = device('America/Los_Angeles', '2026-10-21T13:10:00.500Z');
    expect(tokyo.offset).not.toBe(angeles.offset);
    expect(tokyo.day).toBe('2026-10-21');
    expect(angeles.day).toBe('2026-10-21');
    expect(tokyo.note.id).toBe(angeles.note.id);
    expect(Buffer.from(tokyo.note.update).equals(Buffer.from(angeles.note.update))).toBe(true);

    // Each device writes offline, then they sync both ways.
    const typeInto = (doc: Y.Doc, text: string) =>
      doc.transact(() => {
        const paragraph = new Y.Node('paragraph');
        doc.get(NOTE_ROOT).push([paragraph]);
        paragraph.insert(0, text);
      });
    typeInto(tokyo.doc, 'from Tokyo');
    typeInto(angeles.doc, 'from LA');
    Y.applyUpdate(tokyo.doc, Y.encodeStateAsUpdate(angeles.doc));
    Y.applyUpdate(angeles.doc, Y.encodeStateAsUpdate(tokyo.doc));
    expect(bodyText(tokyo.doc)).toBe(bodyText(angeles.doc));

    const text = bodyText(tokyo.doc);
    expect(text.match(/Plan/g)).toHaveLength(1); // one copy of the template
    expect(text).toContain('from Tokyo');
    expect(text).toContain('from LA');
    expect(readTitle(tokyo.doc)).toBe('2026-10-21');
    expect(readIdentity(tokyo.doc)).toEqual({
      id: tokyo.note.id,
      created: '2026-10-21',
      kind: 'daily',
      period: '2026-10-21',
    });
  });

  it('fills the template and opens in the editor as blocks', () => {
    const note = periodicNote(
      core,
      'weekly',
      isoWeek(core.plainDate(2026, 10, 21)).toString(),
      ['# Week {{week}}', DEFAULT_WEEKLY_TEMPLATE].join('\n\n'),
    );
    expect(note.body).toContain('# Week 2026-W43');
    const replica = createYjs14Replica();
    replica.applyUpdate(note.update);
    const element = document.createElement('div');
    document.body.append(element);
    const collab = createCollabEditor({ element, extensions: noteExtensions(), replica });
    const types = (collab.editor.getJSON().content ?? []).map((node) => node.type);
    expect(types).toEqual(['heading', 'heading', 'heading']);
    collab.destroy();
    element.remove();
  });

  it('keeps both copies when the two devices had different templates', () => {
    const a = device('UTC', '2026-10-21T15:00:00Z', '## Plan\n');
    const b = device('UTC', '2026-10-21T15:00:00Z', '## Agenda\n');
    expect(a.note.id).toBe(b.note.id);
    Y.applyUpdate(a.doc, b.note.update);
    const text = bodyText(a.doc);
    expect(text).toContain('Plan');
    expect(text).toContain('Agenda');
    // The title and identity do not depend on the template: one title, never doubled.
    expect(readTitle(a.doc)).toBe(a.day);
  });

  it('never shares a client id between builds whose codecs produce different content', () => {
    // A20 keeps old builds running: two devices on builds whose parser differs (here, one
    // reads the template's headings one level deeper) must not write different items under
    // the same client id and clocks, or Yjs drops the second as known and they diverge.
    const deeper: Pick<typeof core, 'parseMarkdown'> = {
      parseMarkdown: (markdown) => {
        const parsed = core.parseMarkdown(markdown);
        const json = JSON.parse(JSON.stringify(parsed.doc.toJSON())) as {
          content?: Array<{ type: string; attrs?: { level?: number } }>;
        };
        for (const node of json.content ?? []) {
          if (node.type === 'heading' && node.attrs?.level) node.attrs.level += 1;
        }
        return { ...parsed, doc: parsed.doc.type.schema.nodeFromJSON(json) };
      },
    };
    const day = '2026-10-21';
    const current = periodicNote(core, 'daily', day, DEFAULT_DAILY_TEMPLATE);
    const older = periodicNote(deeper, 'daily', day, DEFAULT_DAILY_TEMPLATE);
    expect(current.id).toBe(older.id);
    expect(Buffer.from(current.update).equals(Buffer.from(older.update))).toBe(false);

    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(a, current.update);
    Y.applyUpdate(b, older.update);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    // Both devices end with the same note: both builds' content, never one each.
    expect(bodyText(a)).toBe(bodyText(b));
    expect(readTitle(a)).toBe(day);

    // The same build still writes byte-identical updates (A4).
    const again = periodicNote(core, 'daily', day, DEFAULT_DAILY_TEMPLATE);
    expect(Buffer.from(again.update).equals(Buffer.from(current.update))).toBe(true);
  });

  it('matches the shared periodic fixture the Android page checks (T40 P5)', () => {
    const cases = (fixture as unknown as { cases: FixtureCase[] }).cases;
    expect(cases.length).toBeGreaterThan(0);
    for (const expected of cases) {
      const note = periodicNote(core, expected.kind, expected.period, expected.template);
      expect(note.id).toBe(expected.id);
      expect(note.body).toBe(expected.body);
      expect(Buffer.from(note.update).toString('base64')).toBe(expected.update);
    }
  });

  it("gives a git notebook's daily note ids of its own, the same on its every device (T50, A820)", () => {
    const salt = '01JBNOTEBOOK00000000000001';
    const workspace = periodicNote(core, 'daily', '2026-10-21', DEFAULT_DAILY_TEMPLATE);
    const one = periodicNote(core, 'daily', '2026-10-21', DEFAULT_DAILY_TEMPLATE, salt);
    const two = periodicNote(core, 'daily', '2026-10-21', DEFAULT_DAILY_TEMPLATE, salt);
    expect(one.id).toBe(periodicNoteId('daily', '2026-10-21', salt));
    expect(one.id).not.toBe(workspace.id);
    expect(one.body).toBe(workspace.body);
    expect(Buffer.from(one.update).equals(Buffer.from(two.update))).toBe(true);
    const clients = (update: Uint8Array) => [
      ...Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update)).keys(),
    ];
    const salted = clients(one.update);
    for (const client of clients(workspace.update)) expect(salted).not.toContain(client);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, one.update);
    expect(readIdentity(doc)?.id).toBe(one.id);
    expect(readTitle(doc)).toBe('2026-10-21');
  });
});

interface FixtureCase {
  readonly kind: PeriodKind;
  readonly period: string;
  readonly template: string;
  readonly id: string;
  readonly body: string;
  readonly update: string;
}
