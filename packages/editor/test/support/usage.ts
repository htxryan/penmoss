/** Session detail's test kit (PEN-177): a note editor with NoteUsage on a fake clock. */
import { eventProblem, type Props, type ScrollClock } from '@penmoss/core/analytics';
import type { JSONContent } from '@tiptap/core';
import { attachNoteUsage, type NoteUsage } from '../../src/usage';
import type { CollabEditor } from '../../src/collab';
import { openEditor } from './editor';

/** A clock that moves only when told, running each timer as its time comes. */
export class FakeClock implements ScrollClock {
  time = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  now = () => this.time;
  set(run: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.time + ms, run });
    return id;
  }
  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(by: number): void {
    const to = this.time + by;
    for (;;) {
      let due: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= to && (!due || entry[1].at < due[1].at)) due = entry;
      }
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].run();
    }
    this.time = to;
  }
}

export interface Recorded {
  readonly name: string;
  readonly props: Props;
  readonly at: number;
}

const BASE = {
  session: '0123456789abcdef',
  seq: 0,
  at: 1,
  client: 'mac',
  actor: 'person',
  version: '1.4.0',
  channel: 'stable',
  os: 'macos',
  osVersion: '26.1',
} as const;

/** Why core's check refuses this event, as main would see it with refs added, or null. */
export function problemOf(event: Recorded): string | null {
  return eventProblem({
    ...BASE,
    kind: 'note',
    name: event.name,
    props: { ...event.props, note: '0123456789abcdef' },
  });
}

export interface UsageHarness {
  readonly collab: CollabEditor;
  readonly usage: NoteUsage;
  readonly clock: FakeClock;
  readonly events: Recorded[];
  title: string;
}

/** An editor holding `content`, recording its session detail; opened unless `open` is false. */
export function usageEditor(content?: JSONContent[], open = true): UsageHarness {
  const collab = openEditor(content);
  const clock = new FakeClock();
  const harness: UsageHarness = {
    collab,
    clock,
    events: [],
    title: 'A title',
    usage: undefined as unknown as NoteUsage,
  };
  (harness as { usage: NoteUsage }).usage = attachNoteUsage(collab.editor, {
    record: (name, props) => harness.events.push({ name, props, at: clock.now() }),
    titleLength: () => harness.title.length,
    clock,
  });
  if (open) harness.usage.open('open');
  return harness;
}

export const p = (text = ''): JSONContent =>
  text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' };
export const h = (level: number, text: string): JSONContent => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});
export const li = (text: string, nested?: JSONContent): JSONContent => ({
  type: 'listItem',
  content: [p(text), ...(nested ? [nested] : [])],
});
export const ul = (...items: JSONContent[]): JSONContent => ({
  type: 'bulletList',
  content: items,
});
