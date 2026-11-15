/**
 * A note holding content from a newer Penmoss, in a git notebook (A158, A1493): the render leaves
 * its file as it is, and the notes API and the local MCP give an agent its text with a notice,
 * refusing edits to its body. Before A1493 such a note read as empty: the render wrote an empty
 * `.md`, and an agent's append replaced the whole note.
 */
import { NOTE_ROOT } from '@penmoss/model/replica';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { LocalError, LocalMcpServer, LocalNotebook } from '../src/local';
import { UNSUPPORTED_RENDER } from '../src/render';
import { testNotebook, type TestClone } from './support/notebooks';

/** Adds a block only a newer Penmoss knows to the end of the note, as its writer would. */
function addFutureBlock(clone: TestClone, noteId: string): void {
  const doc = clone.engine.replica.note(noteId)!;
  doc.transact(() => {
    const block = new Y.Node('futureBlock');
    doc.get(NOTE_ROOT).insert(doc.get(NOTE_ROOT).length, [block]);
    block.insert(0, 'from later');
  });
}

const bodyOf = (clone: TestClone, id: string) =>
  JSON.stringify(clone.engine.replica.note(id)!.get(NOTE_ROOT).toDeltaDeep().toJSON());

const NOTICE = /^This note holds content from a newer Penmoss \(futureBlock\), so only its text/;

async function setup() {
  const nb = testNotebook();
  const a = await nb.open('A', { create: true });
  const id = a.ops.createNote({ title: 'Plan', markdown: '## Beds\n\nKeep me\n' });
  await a.engine.sync();
  const [path, rendered] = [...nb.rendered()].find(([, text]) => text.includes('Keep me'))!;
  const later = await nb.open('Later');
  await later.engine.sync();
  addFutureBlock(later, id);
  return { nb, a, later, id, path, rendered };
}

describe('a note from a newer Penmoss in a git notebook (A1493)', () => {
  it('keeps its file as it is in every render, and reports it as skipped', async () => {
    const { nb, a, later, id, path, rendered } = await setup();
    // The writer that cannot read the body pushes its log, never an empty file.
    const pushed = await later.engine.sync();
    expect(pushed.commit).not.toBeNull();
    expect(nb.rendered().get(path)).toBe(rendered);
    expect(pushed.skipped).toEqual({ [path]: UNSUPPORTED_RENDER });

    // The newer Penmoss renders the file with its block; this build leaves that as it is too.
    const newer = `${rendered}\n<future-block>from later</future-block>\n`;
    await nb.remote.commitAs(nb.branch, { [path]: newer });
    const synced = await a.engine.sync();
    expect(synced.changed).toContain(id);
    expect(bodyOf(a, id)).toContain('from later');
    expect(nb.rendered().get(path)).toBe(newer);
    expect(synced.handEdits).toEqual([]);
    expect(synced.skipped).toEqual({ [path]: UNSUPPORTED_RENDER });
    expect((await a.engine.renderAll(nb.head()!)).wanted.get(path)).toBe(newer);

    // A full render (a new writer's first sync) leaves it too.
    const fresh = await nb.open('Fresh');
    await fresh.engine.sync();
    expect(nb.rendered().get(path)).toBe(newer);
  });

  it('gives the notes API its text with a notice, and refuses edits to its body', async () => {
    const { later, id } = await setup();
    const notebook = new LocalNotebook(later.ops, () => Date.UTC(2026, 9, 29));
    const content = notebook.content(id);
    expect(content.notice).toMatch(NOTICE);
    expect(content.body).toBe('Beds\n\nKeep me\n\nfrom later\n');
    expect(content.markdown).toContain('from later');
    expect(content.headings).toEqual([]);
    const view = notebook.view(id, {});
    expect(view).toMatchObject({ text: content.body, notice: content.notice });
    expect(() => notebook.view(id, { heading: 'Beds' })).toThrow(
      expect.objectContaining({ status: 409, code: 'unsupported_content' }) as Error,
    );

    const before = bodyOf(later, id);
    for (const op of [
      { op: 'append', markdown: 'Appended' },
      { op: 'section', heading: 'Beds', markdown: 'x', mode: 'replace' },
      { op: 'replace', find: 'Keep me', replace: 'Gone', all: false },
    ] as const) {
      let caught: unknown = null;
      try {
        notebook.edit(id, op, null);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LocalError);
      expect(caught).toMatchObject({
        status: 409,
        code: 'unsupported_content',
        message:
          'This note holds content from a newer Penmoss; update Penmoss to edit it. Nothing was changed.',
        details: { nodeTypes: ['futureBlock'] },
      });
      expect(bodyOf(later, id)).toBe(before);
    }
    // Its title can still be set.
    expect(notebook.edit(id, { op: 'properties', title: 'Plan 2' }, null).changed).toBe(true);
    expect(bodyOf(later, id)).toBe(before);
  });

  it('gives an agent on the local MCP the text and the notice, never an empty note', async () => {
    const { later, id } = await setup();
    const notebook = new LocalNotebook(later.ops, () => Date.UTC(2026, 9, 29));
    const mcp = new LocalMcpServer({ use: async (_write, run) => run(notebook) }, 'work');
    let next = 1;
    const tool = async (name: string, args: Record<string, unknown>) => {
      const reply = await mcp.line(
        JSON.stringify({
          jsonrpc: '2.0',
          id: next++,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      );
      return (JSON.parse(reply!) as { result: unknown }).result as {
        isError?: boolean;
        content: { text: string }[];
        structuredContent: Record<string, unknown>;
      };
    };
    const read = await tool('read_note', { id });
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent['notice']).toMatch(NOTICE);
    expect(read.structuredContent['body']).toBe('Beds\n\nKeep me\n\nfrom later\n');
    expect(read.content[0]!.text).toContain('"notice"');
    const before = bodyOf(later, id);
    const appended = await tool('append_to_note', { id, markdown: 'Appended' });
    expect(appended.isError).toBe(true);
    expect(appended.content[0]!.text).toContain('unsupported_content');
    expect(bodyOf(later, id)).toBe(before);
  });
});
