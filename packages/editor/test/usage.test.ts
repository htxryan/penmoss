/**
 * Typing, splices, the cursor and the selection (PEN-177, AC7–AC13): what NoteUsage records as
 * the real editor is typed in, on a fake clock, and that core's replayShape over it always ends
 * at the note's blocks. Every event passes core's check with refs added. Runs in the web and
 * Android editor builds.
 */
import { replayShape, type Props } from '@penmoss/core/analytics';
import { createYjs14Replica } from '@penmoss/model/yjs14';
import { TextSelection } from '@tiptap/pm/state';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createCollabEditor } from '../src/collab';
import { moveSelectedBlock } from '../src/extensions/block-move';
import { noteExtensions } from '../src/extensions';
import { blockTokens, attachNoteUsage } from '../src/usage';
import { paste } from './support/clipboard';
import { press, select, type } from './support/editor';
import { FakeClock, h, li, p, problemOf, ul, usageEditor, type Recorded } from './support/usage';

/** The position just inside block `index` of the note (top-level blocks only). */
function inside(doc: import('@tiptap/pm/model').Node, index: number, offset = 0): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos + 1 + offset;
}

const named = (events: readonly Recorded[], name: string) =>
  events.filter((event) => event.name === name);

/** The replay of `events` from their first note open. */
function replay(events: readonly Recorded[]): string[] {
  const open = events.find((event) => event.name === 'open')!;
  const rest = events.slice(events.indexOf(open) + 1);
  return replayShape(
    open.props,
    rest.map((event) => ({ kind: 'note', ...event })),
  );
}

function expectValid(events: readonly Recorded[]): void {
  for (const event of events) expect(problemOf(event), JSON.stringify(event)).toBeNull();
}

describe('typing bursts (AC8)', () => {
  it('records at most one burst a second per block, with no character', () => {
    const { collab, clock, events } = usageEditor([p('Hello'), p('World')]);
    const view = collab.editor.view;
    select(view, inside(view.state.doc, 1, 5));
    for (let i = 0; i < 40; i++) {
      type(view, 'q');
      clock.advance(75);
    }
    clock.advance(2000);
    const bursts = named(events, 'typing');
    expect(bursts.length).toBeGreaterThanOrEqual(3);
    expect(bursts.length).toBeLessThanOrEqual(4);
    expect(bursts.every((burst) => burst.props['block'] === 1)).toBe(true);
    expect(bursts.reduce((sum, burst) => sum + (burst.props['typed'] as number), 0)).toBe(40);
    expect(JSON.stringify(events)).not.toContain('q');
    expect(replay(events)).toEqual(blockTokens(view.state.doc));
    expectValid(events);
  });

  it('counts a replacement as typed and deleted', () => {
    const { collab, clock, events } = usageEditor([p('Hello world')]);
    const view = collab.editor.view;
    select(view, 1, 6);
    type(view, 'J');
    clock.advance(1000);
    expect(named(events, 'typing').map((event) => event.props)).toEqual([
      { block: 0, typed: 1, deleted: 5 },
    ]);
  });

  it('records the title’s typing as the title, and a cursor there', () => {
    const harness = usageEditor([p('Body')]);
    harness.usage.titleFocused();
    harness.clock.advance(400);
    harness.usage.title('A title', 'A new title');
    harness.clock.advance(1000);
    expect(named(harness.events, 'cursor').map((event) => event.props)).toEqual([{ title: true }]);
    expect(named(harness.events, 'typing').map((event) => event.props)).toEqual([
      { title: true, typed: 4, deleted: 0 },
    ]);
  });

  it('flushes a pending burst before any other note event', () => {
    const { collab, clock, events } = usageEditor([p('One'), p('Two')]);
    const view = collab.editor.view;
    select(view, inside(view.state.doc, 0, 3));
    type(view, 'xy');
    press(view, 'Enter');
    expect(events.map((event) => event.name)).toEqual(['open', 'typing', 'blocks']);
    clock.advance(2000);
    expect(replay(events)).toEqual(blockTokens(view.state.doc));
  });
});

describe('splices (AC9)', () => {
  it('records Enter as one splice of the block it split', () => {
    const { collab, events } = usageEditor([p('Hello world'), p('End')]);
    const view = collab.editor.view;
    select(view, inside(view.state.doc, 0, 5));
    press(view, 'Enter');
    expect(named(events, 'blocks').map((event) => event.props)).toEqual([
      { block: 0, removed: 1, inserted: ['p:5', 'p:6'] },
    ]);
    expect(replay(events)).toEqual(blockTokens(view.state.doc));
  });

  it('records Backspace at a block’s start as a merge', () => {
    const { collab, events } = usageEditor([p('One'), p('Two')]);
    const view = collab.editor.view;
    select(view, inside(view.state.doc, 1));
    press(view, 'Backspace');
    expect(named(events, 'blocks').map((event) => event.props)).toEqual([
      { block: 0, removed: 2, inserted: ['p:6'] },
    ]);
  });

  it('records a paste of three blocks', () => {
    const harness = usageEditor([p('Start'), p('End')]);
    const view = harness.collab.editor.view;
    select(view, inside(view.state.doc, 0, 5));
    paste(harness.collab, { 'text/html': '<h2>Plan</h2><p>one</p><ul><li>two</li></ul>' });
    const blocks = named(harness.events, 'blocks');
    expect(blocks).toHaveLength(1);
    expect(replay(harness.events)).toEqual(blockTokens(view.state.doc));
    expect(JSON.stringify(harness.events)).not.toMatch(/Plan|one|two/);
  });

  it('records a turn into a heading as a change of kind', () => {
    const { collab, events } = usageEditor([p('Title here'), p('Body')]);
    const view = collab.editor.view;
    select(view, inside(view.state.doc, 0, 2));
    collab.editor.commands.toggleHeading({ level: 2 });
    expect(named(events, 'blocks').map((event) => event.props)).toEqual([
      { block: 0, removed: 1, inserted: ['h2:10'] },
    ]);
  });

  it('records a block moved down', () => {
    const { collab, events } = usageEditor([h(1, 'Top'), p('Alpha'), p('Beta')]);
    const view = collab.editor.view;
    select(view, inside(view.state.doc, 1, 1));
    moveSelectedBlock(1)(view.state, view.dispatch, view);
    expect(blockTokens(view.state.doc)).toEqual(['h1:3', 'p:4', 'p:5']);
    expect(named(events, 'blocks')).toHaveLength(1);
    expect(replay(events)).toEqual(['h1:3', 'p:4', 'p:5']);
  });

  it('records typing in a list item at its position among the blocks', () => {
    const { collab, clock, events } = usageEditor([ul(li('one', ul(li('two'))), li('three')), p()]);
    const view = collab.editor.view;
    let found = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'three') found = pos + 5;
      return found === -1;
    });
    select(view, found);
    type(view, '!!');
    clock.advance(1000);
    expect(named(events, 'typing').map((event) => event.props)).toEqual([
      { block: 2, typed: 2, deleted: 0 },
    ]);
    expect(replay(events)).toEqual(['li.b.1:3', 'li.b.2:3', 'li.b.1:7', 'p:0']);
  });
});

describe('the cursor and the selection (AC10, AC11)', () => {
  it('records the cursor once it settles in another block, not for typing', () => {
    const { collab, clock, events } = usageEditor([p('a'), p('b'), p('c'), p('d'), p('e')]);
    const view = collab.editor.view;
    select(view, inside(view.state.doc, 3));
    clock.advance(400);
    select(view, inside(view.state.doc, 4));
    clock.advance(1200);
    type(view, 'xyz');
    clock.advance(2000);
    expect(named(events, 'cursor').map((event) => event.props)).toEqual([
      { block: 3 },
      { block: 4 },
    ]);
  });

  it('records a selection across two blocks by its start, length and span, once', () => {
    const { collab, clock, events } = usageEditor([p('Hello'), p('World'), p('!')]);
    const view = collab.editor.view;
    select(view, inside(view.state.doc, 0, 2), inside(view.state.doc, 1, 3));
    clock.advance(400);
    select(view, inside(view.state.doc, 0, 2), inside(view.state.doc, 1, 3));
    clock.advance(2000);
    expect(named(events, 'select').map((event) => event.props)).toEqual([
      { block: 0, chars: 6, span: 2 },
    ]);
    expectValid(events);
  });
});

describe('remote changes (AC12)', () => {
  it('records another replica’s change as remote, without a cursor or a selection', () => {
    const element = document.createElement('div');
    document.body.append(element);
    const here = createYjs14Replica();
    const there = createYjs14Replica();
    const mine = createCollabEditor({ element, extensions: noteExtensions(), replica: here });
    const theirs = createCollabEditor({
      element: document.createElement('div'),
      extensions: noteExtensions(),
      replica: there,
    });
    theirs.editor.commands.setContent({ type: 'doc', content: [p('Shared'), p('Note')] });
    here.applyUpdate(there.encodeStateAsUpdate(here.encodeStateVector()), 'remote');
    const clock = new FakeClock();
    const events: Recorded[] = [];
    const usage = attachNoteUsage(mine.editor, {
      record: (name, props: Props) => events.push({ name, props, at: clock.now() }),
      clock,
    });
    usage.open();
    const sync = () =>
      here.applyUpdate(there.encodeStateAsUpdate(here.encodeStateVector()), 'remote');
    // Typing over there.
    const tv = theirs.editor.view;
    tv.dispatch(tv.state.tr.setSelection(TextSelection.create(tv.state.doc, 7)));
    tv.dispatch(tv.state.tr.insertText('!!', 7));
    sync();
    // A block added over there.
    tv.dispatch(
      tv.state.tr.insert(tv.state.doc.content.size, tv.state.schema.nodeFromJSON(p('More'))),
    );
    sync();
    clock.advance(3000);
    const typing = named(events, 'typing');
    expect(typing.length).toBeGreaterThan(0);
    expect(typing.every((event) => event.props['remote'] === true)).toBe(true);
    expect(named(events, 'blocks').every((event) => event.props['remote'] === true)).toBe(true);
    expect(named(events, 'cursor')).toEqual([]);
    expect(named(events, 'select')).toEqual([]);
    expect(replay(events)).toEqual(blockTokens(mine.editor.state.doc));
    expectValid(events);
    usage.destroy();
    mine.destroy();
    theirs.destroy();
  });

  it('records this editor’s own Undo as its own, not remote', () => {
    const { collab, clock, events } = usageEditor([p('Hello')]);
    const view = collab.editor.view;
    select(view, 6);
    type(view, 'abc');
    clock.advance(1500);
    collab.undo();
    clock.advance(1500);
    expect(events.some((event) => event.props['remote'] === true)).toBe(false);
    expect(replay(events)).toEqual(blockTokens(view.state.doc));
  });
});

describe('the open waits for the note’s content (AC5)', () => {
  /** An editor on an empty replica, as the Mac mounts one before the note's text is read from disk. */
  function loadingEditor() {
    const element = document.createElement('div');
    document.body.append(element);
    const here = createYjs14Replica();
    const disk = createYjs14Replica();
    const mine = createCollabEditor({ element, extensions: noteExtensions(), replica: here });
    const stored = createCollabEditor({
      element: document.createElement('div'),
      extensions: noteExtensions(),
      replica: disk,
    });
    stored.editor.commands.setContent({
      type: 'doc',
      content: [h(1, 'Seeds'), p('Row one'), p('Row two'), ul(li('beans'))],
    });
    disk.doc.get('title').insert(0, 'Garden');
    const clock = new FakeClock();
    const events: Recorded[] = [];
    const usage = attachNoteUsage(mine.editor, {
      record: (name, props: Props) => events.push({ name, props, at: clock.now() }),
      titleLength: () => here.doc.get('title').toString().length,
      clock,
    });
    const arrive = () =>
      here.applyUpdate(disk.encodeStateAsUpdate(here.encodeStateVector()), 'pull');
    const done = () => {
      usage.destroy();
      mine.destroy();
      stored.destroy();
      element.remove();
    };
    return { mine, usage, clock, events, arrive, done };
  }

  it('records the shape once the content arrives after mount, not the empty placeholder', () => {
    const { mine, usage, clock, events, arrive, done } = loadingEditor();
    usage.open('open');
    // Mounted, the text not read yet: nothing, and a click in the blank editor records nothing.
    const view = mine.editor.view;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    clock.advance(2000);
    expect(events).toEqual([]);
    arrive();
    expect(events.map((event) => event.name)).toEqual(['open']);
    expect(events[0]!.props).toEqual({
      how: 'open',
      titleChars: 6,
      // The editor's trailing paragraph after a list is in the note too.
      shape: ['h1:5', 'p:7', 'p:7', 'li.b.1:5', 'p:0'],
    });
    // From then on, typing and splices follow from that shape.
    select(view, inside(view.state.doc, 1, 7));
    type(view, '!!');
    press(view, 'Enter');
    clock.advance(2000);
    expect(named(events, 'open')).toHaveLength(1);
    expect(replay(events)).toEqual(blockTokens(view.state.doc));
    expectValid(events);
    done();
  });

  it('keeps how a tab switched to was shown', () => {
    const { usage, events, arrive, done } = loadingEditor();
    usage.open('switch');
    arrive();
    expect(named(events, 'open').map((event) => event.props['how'])).toEqual(['switch']);
    done();
  });

  it('records a note that is really empty as the person first types in it, then the typing', () => {
    const { collab, clock, events, usage } = usageEditor([p()]);
    expect(events).toEqual([]);
    const view = collab.editor.view;
    select(view, 1);
    type(view, 'abc');
    clock.advance(1500);
    expect(events.map((event) => event.name)).toEqual(['open', 'typing']);
    expect(events[0]!.props).toEqual({ how: 'open', titleChars: 7, shape: ['p:0'] });
    expect(events[1]!.props).toEqual({ block: 0, typed: 3, deleted: 0 });
    expect(replay(events)).toEqual(blockTokens(view.state.doc));
    usage.destroy();
    expect(named(events, 'open')).toHaveLength(1);
  });

  it('records a new note’s open with the title as it was before its first character', () => {
    const harness = usageEditor([p()]);
    harness.usage.titleFocused();
    harness.clock.advance(1000);
    expect(harness.events).toEqual([]);
    harness.title = 'G';
    harness.usage.title('', 'G');
    harness.clock.advance(1000);
    expect(harness.events.map((event) => [event.name, event.props])).toEqual([
      ['open', { how: 'open', titleChars: 0, shape: ['p:0'] }],
      ['typing', { title: true, typed: 1, deleted: 0 }],
    ]);
  });

  it('records an empty note shown and left untouched as it closes', () => {
    const { events, usage } = usageEditor([p()]);
    usage.flush();
    expect(events).toEqual([]);
    usage.destroy();
    expect(events.map((event) => [event.name, event.props])).toEqual([
      ['open', { how: 'open', titleChars: 7, shape: ['p:0'] }],
    ]);
  });
});

describe('limits and clamping (AC7, AC7b)', () => {
  it('resyncs when all of a 6,000-block note is deleted', () => {
    const blocks = Array.from({ length: 6000 }, (_, i) => p(`line ${i}`));
    const { collab, events } = usageEditor(blocks);
    const view = collab.editor.view;
    view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));
    const opens = named(events, 'open');
    expect(opens).toHaveLength(2);
    expect(opens[1]!.props['how']).toBe('resync');
    expect(replay(events)).toEqual(blockTokens(view.state.doc));
    expectValid(events);
  });

  it('records typing past a capped shape with its counts and no block', () => {
    const blocks = Array.from({ length: 6000 }, (_, i) => p(`line ${i}`));
    const { collab, clock, events } = usageEditor(blocks);
    const view = collab.editor.view;
    const shown = (named(events, 'open')[0]!.props['shape'] as string[]).length;
    select(view, inside(view.state.doc, 5900, 2));
    type(view, 'xy');
    clock.advance(1500);
    expect(named(events, 'typing').map((event) => event.props)).toEqual([{ typed: 2, deleted: 0 }]);
    expect(replay(events)).toEqual(blockTokens(view.state.doc).slice(0, shown));
    expectValid(events);
  });

  it('clamps a paste of 2,000,000 characters, and nests a list 12 deep, every event valid', () => {
    const { collab, clock, events } = usageEditor([p('Start')]);
    const view = collab.editor.view;
    select(view, 6);
    view.dispatch(view.state.tr.insertText('y'.repeat(2_000_000), 6));
    clock.advance(1500);
    const typing = named(events, 'typing');
    expect(typing.at(-1)!.props['typed']).toBe(1_000_000);
    let nested = ul(li('deep'));
    for (let i = 0; i < 11; i++) nested = ul(li('x', nested));
    collab.editor.commands.insertContentAt(view.state.doc.content.size, nested);
    clock.advance(1500);
    expectValid(events);
    expect(blockTokens(view.state.doc).some((token) => token.startsWith('li.b.9:'))).toBe(true);
  });
});

/** One scripted step of a random session. */
type Action =
  | { readonly kind: 'type'; readonly block: number; readonly text: string }
  | { readonly kind: 'enter'; readonly block: number }
  | { readonly kind: 'backspace'; readonly block: number }
  | { readonly kind: 'heading'; readonly block: number; readonly level: number }
  | { readonly kind: 'paste'; readonly block: number }
  | { readonly kind: 'delete'; readonly block: number }
  | { readonly kind: 'remote'; readonly block: number; readonly text: string }
  | { readonly kind: 'wait'; readonly ms: number };

const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('type' as const),
      block: fc.nat(30),
      text: fc.string({ minLength: 1, maxLength: 6 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('enter' as const), block: fc.nat(30) }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('backspace' as const), block: fc.nat(30) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('heading' as const),
      block: fc.nat(30),
      level: fc.integer({ min: 1, max: 3 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('paste' as const), block: fc.nat(30) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), block: fc.nat(30) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('remote' as const),
      block: fc.nat(30),
      text: fc.string({ minLength: 1, maxLength: 4 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('wait' as const),
      ms: fc.integer({ min: 10, max: 1500 }),
    }),
  },
);

describe('replay (AC13)', () => {
  it('ends at the note’s blocks after 200 random sessions', () => {
    fc.assert(
      fc.property(fc.array(action, { minLength: 1, maxLength: 25 }), (actions) => {
        const element = document.createElement('div');
        document.body.append(element);
        const here = createYjs14Replica();
        const there = createYjs14Replica();
        const mine = createCollabEditor({ element, extensions: noteExtensions(), replica: here });
        const theirs = createCollabEditor({
          element: document.createElement('div'),
          extensions: noteExtensions(),
          replica: there,
        });
        const toThem = () =>
          there.applyUpdate(here.encodeStateAsUpdate(there.encodeStateVector()), 'remote');
        const toMe = () =>
          here.applyUpdate(there.encodeStateAsUpdate(here.encodeStateVector()), 'remote');
        try {
          mine.editor.commands.setContent({
            type: 'doc',
            content: [h(1, 'Plan'), p('First line'), ul(li('one'), li('two')), p('Last')],
          });
          toThem();
          const clock = new FakeClock();
          const events: Recorded[] = [];
          const usage = attachNoteUsage(mine.editor, {
            record: (name, props: Props) => events.push({ name, props, at: clock.now() }),
            clock,
          });
          usage.open();
          const view = mine.editor.view;
          const textPositions = () => {
            const positions: number[] = [];
            view.state.doc.descendants((node, pos) => {
              if (node.isTextblock) positions.push(pos + 1 + node.content.size);
              return true;
            });
            return positions;
          };
          for (const step of actions) {
            if (step.kind === 'wait') {
              clock.advance(step.ms);
              continue;
            }
            if (step.kind === 'remote') {
              toThem();
              const tv = theirs.editor.view;
              const ends: number[] = [];
              tv.state.doc.descendants((node, pos) => {
                if (node.isTextblock) ends.push(pos + 1 + node.content.size);
                return true;
              });
              const at = ends[step.block % ends.length]!;
              tv.dispatch(tv.state.tr.insertText(step.text, at));
              toMe();
              continue;
            }
            const positions = textPositions();
            const at = positions[step.block % positions.length]!;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
            if (step.kind === 'type') type(view, step.text.replace(/[\n\t]/g, ' '));
            else if (step.kind === 'enter') press(view, 'Enter');
            else if (step.kind === 'backspace') press(view, 'Backspace');
            else if (step.kind === 'heading')
              mine.editor.commands.toggleHeading({ level: step.level as 1 | 2 | 3 });
            else if (step.kind === 'paste')
              paste(mine, { 'text/html': '<p>a</p><p>bb</p><p>ccc</p>' });
            else if (step.kind === 'delete') {
              const $at = view.state.doc.resolve(at);
              if (view.state.doc.childCount > 1 && $at.depth >= 1) {
                view.dispatch(view.state.tr.delete($at.before(1), $at.after(1)));
              }
            }
            clock.advance(5);
          }
          usage.flush();
          for (const event of events) {
            if (problemOf(event) !== null)
              throw new Error(`${JSON.stringify(event)}: ${problemOf(event)}`);
          }
          const replayed = replay(events);
          const actual = blockTokens(view.state.doc);
          if (JSON.stringify(replayed) !== JSON.stringify(actual)) {
            throw new Error(`replay ${JSON.stringify(replayed)} ≠ ${JSON.stringify(actual)}`);
          }
          usage.destroy();
        } finally {
          mine.destroy();
          theirs.destroy();
          element.remove();
        }
      }),
      { numRuns: 200, seed: 177 },
    );
  });
});
