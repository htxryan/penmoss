// @vitest-environment happy-dom
import { readThreads, orderThreads } from '@penmoss/sync-client/comments';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { CommandsContext } from '../../src/commands/hooks';
import { CommentPopover } from '../../src/notes/CommentPopover';
import { CommentsPanel } from '../../src/notes/CommentsPanel';
import { startNoteThread } from '../../src/notes/comments';
import { SourceContext } from '../../src/sources/hooks';
import type { Source } from '../../src/sources/registry';

// T52 item 5: a thread on the note as a whole from the Comments tab, listed first; a new
// thread's composer floating over the note, closed by Escape.

const RYAN = { id: 'device:d', kind: 'device', label: 'MacBook' } as const;
const GIT = {
  id: 'git-1',
  kind: 'git',
  // Its WorkspaceDoc, with no agent sessions in it (T60, A1060).
  workspace: {
    doc: createYjs14Replica().doc,
    subscribe: () => () => undefined,
    getState: () => ({ loaded: true }),
  },
  agentSent: () => Promise.resolve(),
} as unknown as Source;

let unmount = () => undefined as void;
afterEach(() => unmount());

function mount(node: React.ReactNode, commands = new CommandCenter(COMMANDS, memoryBindings())) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  // A git notebook's source, the only kind (D49).
  const render = (next: React.ReactNode) =>
    act(() =>
      root.render(
        <CommandsContext.Provider value={commands}>
          <SourceContext.Provider value={GIT}>{next}</SourceContext.Provider>
        </CommandsContext.Provider>,
      ),
    );
  render(node);
  return { container, render, commands };
}

const placedOf = (replica: Yjs14Replica) => orderThreads(replica.doc, readThreads(replica.doc));

function type(field: HTMLTextAreaElement, text: string) {
  act(() => {
    // React tracks the value through the prototype's setter, so it sees this as typing.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the Comments tab (T52 item 5)', () => {
  it('offers Add Note Comment, and writes a thread on the note as a whole', () => {
    const replica = createYjs14Replica();
    const ran = vi.fn();
    const commands = new CommandCenter(COMMANDS, memoryBindings());
    commands.register('note.addNoteComment', { run: ran });
    const done = vi.fn();
    const panel = (noteDraft: boolean) => (
      <CommentsPanel
        noteId="01JNOTE000000000000000000A"
        replica={replica}
        threads={placedOf(replica)}
        active={null}
        onActive={() => undefined}
        noteDraft={noteDraft}
        onNoteDraftDone={done}
        floating={null}
      />
    );
    const { container, render } = mount(panel(false), commands);
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="comments-add-note"]')!.click(),
    );
    expect(ran).toHaveBeenCalledOnce();
    render(panel(true));
    expect(container.querySelector('[data-testid="comments-add-note"]')).toBeNull();
    expect(container.querySelector('[data-testid="comment-note-draft"]')?.textContent).toContain(
      'The note as a whole',
    );
    type(container.querySelector('[data-testid="comment-new"]')!, 'A summary at the top?');
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-testid="comment-new-send"]')!.click(),
    );
    expect(done).toHaveBeenCalledOnce();
    const [made] = readThreads(replica.doc);
    expect(made).toMatchObject({ scope: 'note', quote: '' });
    expect(made!.comments[0]!.body).toBe('A summary at the top?');
  });

  it('lists threads on the note as a whole first, marked so', () => {
    const replica = createYjs14Replica();
    startNoteThread(replica, 'First', RYAN, null);
    const { container } = mount(
      <CommentsPanel
        noteId="01JNOTE000000000000000000A"
        replica={replica}
        threads={placedOf(replica)}
        active={null}
        onActive={() => undefined}
        noteDraft={false}
        onNoteDraftDone={() => undefined}
        floating={null}
      />,
    );
    const first = container.querySelector('[data-testid="comment-thread"]')!;
    expect(first.querySelector('[data-testid="comment-note-level"]')).not.toBeNull();
    expect(first.querySelector('[data-testid="comment-orphaned"]')).toBeNull();
  });
});

describe('a comment floating over the note (T52 item 5)', () => {
  it('composes a new thread there, and Escape closes it, giving the editor its focus back', () => {
    const replica = createYjs14Replica();
    const onClose = vi.fn();
    const { container } = mount(
      <CommentPopover
        noteId="01JNOTE000000000000000000A"
        editor={null}
        replica={replica}
        threads={[]}
        floating={{
          kind: 'draft',
          draft: { anchor: { from: { tname: 'x' }, to: null }, quote: 'a passage', kind: 'range' },
        }}
        onClose={onClose}
        onCreated={() => undefined}
      />,
    );
    const popover = container.querySelector<HTMLElement>('[data-testid="comment-popover"]')!;
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.querySelector('[data-testid="comment-draft"]')?.textContent).toContain(
      'a passage',
    );
    const field = popover.querySelector<HTMLTextAreaElement>('[data-testid="comment-new"]')!;
    expect(document.activeElement).toBe(field);
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('closes an empty composer on a click outside, and keeps one with words in it', () => {
    const replica = createYjs14Replica();
    const onClose = vi.fn();
    const { container } = mount(
      <CommentPopover
        noteId="01JNOTE000000000000000000A"
        editor={null}
        replica={replica}
        threads={[]}
        floating={{
          kind: 'draft',
          draft: { anchor: { from: { tname: 'x' }, to: null }, quote: 'a passage', kind: 'range' },
        }}
        onClose={onClose}
        onCreated={() => undefined}
      />,
    );
    const outside = document.createElement('p');
    document.body.append(outside);
    const clickOutside = () =>
      act(() => {
        outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      });
    const field = container.querySelector<HTMLTextAreaElement>('[data-testid="comment-new"]')!;
    type(field, 'Half a thought');
    clickOutside();
    expect(onClose).not.toHaveBeenCalled();
    // A click inside never closes it.
    act(() => {
      field.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    type(field, '   ');
    clickOutside();
    expect(onClose).toHaveBeenCalledWith(false);
    outside.remove();
  });

  it('shows a thread opened from its passage, and Escape in its reply closes it', () => {
    const replica = createYjs14Replica();
    const id = startNoteThread(replica, 'On the passage', RYAN, null);
    const onClose = vi.fn();
    const { container } = mount(
      <CommentPopover
        noteId="01JNOTE000000000000000000A"
        editor={null}
        replica={replica}
        threads={placedOf(replica)}
        floating={{ kind: 'thread', id, focus: true }}
        onClose={onClose}
        onCreated={() => undefined}
      />,
    );
    const thread = container.querySelector('[data-testid="comment-floating-thread"]')!;
    expect(thread.textContent).toContain('On the passage');
    const reply = thread.querySelector<HTMLTextAreaElement>('[data-testid="comment-reply"]')!;
    expect(document.activeElement).toBe(reply);
    act(() => {
      reply.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('keeps focus in the reply once Send is clicked, so Escape still closes the thread', () => {
    const replica = createYjs14Replica();
    const id = startNoteThread(replica, 'On the passage', RYAN, null);
    const onClose = vi.fn();
    const { container } = mount(
      <CommentPopover
        noteId="01JNOTE000000000000000000A"
        editor={null}
        replica={replica}
        threads={placedOf(replica)}
        floating={{ kind: 'thread', id, focus: true }}
        onClose={onClose}
        onCreated={() => undefined}
      />,
    );
    const reply = container.querySelector<HTMLTextAreaElement>('[data-testid="comment-reply"]')!;
    type(reply, 'Or cut it');
    const send = container.querySelector<HTMLButtonElement>('[data-testid="comment-reply-send"]')!;
    act(() => {
      send.focus();
      send.click();
    });
    expect(send.disabled).toBe(true);
    expect(document.activeElement).toBe(reply);
  });
});
