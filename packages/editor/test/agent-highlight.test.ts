import { NOTE_ROOT } from '@penmoss/sync-client';
import { setTitle } from '@penmoss/sync-client/note';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import * as Y from '@y/y';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_HIGHLIGHT_MS, highlightAgentEdit } from '../src/extensions/agent-highlight';
import { openEditor, paragraph, select, type } from './support/editor';

const highlighted = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('.pm-agent-edit')].map((element) => ({
    text: element.textContent,
    agent: element.dataset.agent,
    title: element.title,
  }));

afterEach(() => vi.useRealTimers());

/** A second copy of the note that edits like the server does, then sends its update. */
function remoteOf(local: ReturnType<typeof openEditor>) {
  const remote = createYjs14Replica();
  remote.applyUpdate(local.replica.encodeStateAsUpdate());
  return {
    edit(block: number, offset: number, text: string): Uint8Array {
      const before = remote.encodeStateVector();
      (remote.doc.get(NOTE_ROOT).get(block) as Y.Node).insert(offset, text);
      return Y.encodeStateAsUpdate(remote.doc, before);
    },
    titleOnly(title: string): Uint8Array {
      const before = remote.encodeStateVector();
      setTitle(remote.doc, title);
      return Y.encodeStateAsUpdate(remote.doc, before);
    },
  };
}

describe('agent edit highlight (T24)', () => {
  it('highlights what an announced agent edit changed, naming the agent', () => {
    const collab = openEditor([paragraph('Human text'), paragraph('Agent text')]);
    const remote = remoteOf(collab);
    const update = remote.edit(1, 10, ' and more');
    highlightAgentEdit(collab.editor, 'Claude Code');
    collab.replica.applyUpdate(update, 'server');
    expect(highlighted(collab.editor.view.dom)).toEqual([
      { text: ' and more', agent: 'Claude Code', title: 'Edited by Claude Code' },
    ]);
    // One label names the agent beside its change (it is not part of the text).
    const labels = [...collab.editor.view.dom.querySelectorAll('.pm-agent-label')];
    expect(labels.map((label) => label.textContent)).toEqual(['Claude Code']);
    expect(collab.editor.state.doc.textContent).toBe('Human textAgent text and more');
  });

  it('leaves the user’s own typing and unannounced remote edits alone', () => {
    const collab = openEditor([paragraph('Human text'), paragraph('Agent text')]);
    const remote = remoteOf(collab);
    collab.replica.applyUpdate(remote.edit(1, 0, 'Another device: '), 'server');
    const { view } = collab.editor;
    select(view, 11);
    type(view, '!');
    expect(highlighted(view.dom)).toEqual([]);

    // An announcement covers only the next remote change.
    highlightAgentEdit(collab.editor, 'Codex');
    collab.replica.applyUpdate(remote.edit(0, 0, 'A'), 'server');
    collab.replica.applyUpdate(remote.edit(0, 0, 'B'), 'server');
    expect(highlighted(view.dom).map((h) => h.text)).toEqual(['A']);
  });

  it('fades away on its own and never writes to the document', () => {
    vi.useFakeTimers();
    const collab = openEditor([paragraph('Agent text')]);
    const remote = remoteOf(collab);
    highlightAgentEdit(collab.editor, 'Claude Code');
    collab.replica.applyUpdate(remote.edit(0, 0, 'New '), 'server');
    const before = JSON.stringify(collab.replica.doc.get(NOTE_ROOT).toDeltaDeep().toJSON());
    expect(highlighted(collab.editor.view.dom)).toHaveLength(1);
    vi.advanceTimersByTime(AGENT_HIGHLIGHT_MS + 100);
    expect(highlighted(collab.editor.view.dom)).toEqual([]);
    expect(collab.editor.view.dom.querySelector('.pm-agent-label')).toBeNull();
    expect(JSON.stringify(collab.replica.doc.get(NOTE_ROOT).toDeltaDeep().toJSON())).toBe(before);
  });

  it('disarms after the announced update even when it changed nothing shown (T24 review #2)', () => {
    const collab = openEditor([paragraph('Agent text')]);
    const remote = remoteOf(collab);
    // The announced update only sets the title: the body does not change.
    const disarm = highlightAgentEdit(collab.editor, 'Claude Code');
    const before = remote.titleOnly('Renamed by Claude');
    collab.replica.applyUpdate(before, 'server');
    disarm();
    // A collaborator's keystroke a moment later is not taken for the agent's edit.
    collab.replica.applyUpdate(remote.edit(0, 0, 'Human '), 'server');
    expect(highlighted(collab.editor.view.dom)).toEqual([]);
    expect(collab.editor.view.dom.querySelector('.pm-agent-label')).toBeNull();
  });

  it('forgets an announcement whose update never came', () => {
    vi.useFakeTimers();
    const collab = openEditor([paragraph('Agent text')]);
    const remote = remoteOf(collab);
    highlightAgentEdit(collab.editor, 'Claude Code');
    vi.advanceTimersByTime(AGENT_HIGHLIGHT_MS);
    collab.replica.applyUpdate(remote.edit(0, 0, 'Late '), 'server');
    expect(highlighted(collab.editor.view.dom)).toEqual([]);
  });
});
