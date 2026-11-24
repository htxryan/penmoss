/**
 * Managing tags in a git notebook (the Tags page, finding 8 of Ryan's review of #192): renaming
 * into a tag that exists (a merge), and deleting a tag from every note, Trash included.
 */
import { describe, expect, it } from 'vitest';
import { LocalNotebook, propertiesOp } from '../src/local';
import { testNotebook } from './support/notebooks';

async function setup() {
  const nb = testNotebook();
  const clone = await nb.open('Agent', { create: true, kind: 'agent' });
  const notebook = new LocalNotebook(clone.ops, nb.clock);
  const create = (title: string, markdown: string, tags: string[] = []) =>
    notebook.create({ title, markdown, tags, folderId: null }).reply.id;
  return { notebook, create };
}

describe('a tag’s AI description reads the notes (A1677)', () => {
  it('gives every live note, newest first, with its title, tags, description and text', async () => {
    const nb = testNotebook();
    const clone = await nb.open('Agent', { create: true, kind: 'agent' });
    const notebook = new LocalNotebook(clone.ops, nb.clock);
    const beds = notebook.create({
      title: 'Beds',
      markdown: 'Raised #garden beds',
      tags: [],
      folderId: null,
    }).reply.id;
    nb.tick();
    const seeds = notebook.create({
      title: 'Seeds',
      markdown: 'Order seeds',
      tags: ['garden', 'shopping'],
      folderId: null,
    }).reply.id;
    notebook.edit(seeds, propertiesOp({ description: 'What to sow in spring.' }), null);
    nb.tick();
    const old = notebook.create({
      title: 'Old',
      markdown: 'An old #garden plan',
      tags: [],
      folderId: null,
    }).reply.id;
    notebook.trash(old);

    const notes = notebook.tagPromptNotes();
    expect(notes.map((note) => note.title)).toEqual(['Seeds', 'Beds']);
    expect(notes[0]).toMatchObject({
      tags: ['garden', 'shopping'],
      description: 'What to sow in spring.',
    });
    expect(notes[1]).toMatchObject({ tags: ['garden'], description: null });
    expect(notes[1]!.text).toContain('Raised #garden beds');
    expect(beds).not.toBe(seeds);
  });
});

describe('tags in a git notebook', () => {
  it('refuses to rename into a tag that exists unless asked to merge, then merges', async () => {
    const { notebook, create } = await setup();
    const cf = create('Workers', 'Deploy with #cf today');
    const both = create('R2', 'Buckets #cf and #cloudflare');
    const cloud = create('D1', 'Tables', ['cloudflare']);
    expect(() => notebook.renameTag({ from: 'cf', to: 'cloudflare' })).toThrow(/exists already/);

    const merged = notebook.renameTag({ from: 'cf', to: 'cloudflare', merge: true });
    expect(merged.notes.sort()).toEqual([cf, both].sort());
    expect(notebook.content(cf).tags).toEqual(['cloudflare']);
    expect(notebook.content(cf).body).toContain('Deploy with #cloudflare today');
    expect(notebook.content(both).tags).toEqual(['cloudflare']);
    expect(notebook.content(cloud).tags).toEqual(['cloudflare']);
    expect(notebook.tags().tags).toEqual([{ name: 'cloudflare', notes: 3 }]);
  });

  it('deletes a tag and those nested under it from every note, Trash too; the notes stay', async () => {
    const { notebook, create } = await setup();
    const inline = create('Beds', 'Raised #garden beds and #garden/herbs, with #tools');
    const front = create('Seeds', 'Order seeds', ['garden', 'shopping']);
    const trashed = create('Old', 'An old #garden plan');
    const other = create('Shed', 'Fix the #gardening shed');
    notebook.trash(trashed);

    const deleted = notebook.deleteTag({ tag: '#Garden' });
    expect(deleted.tag).toBe('garden');
    expect(deleted.notes.sort()).toEqual([inline, front, trashed].sort());
    expect(notebook.content(inline).tags).toEqual(['tools']);
    // The word stays in the sentence, without its `#`.
    expect(notebook.content(inline).body).toContain(
      'Raised garden beds and garden/herbs, with #tools',
    );
    expect(notebook.content(front).tags).toEqual(['shopping']);
    expect(notebook.content(trashed).tags).toEqual([]);
    expect(notebook.content(trashed).deleted).toBe(true);
    expect(notebook.content(other).tags).toEqual(['gardening']);
    expect(notebook.tags().tags.map((tag) => tag.name)).toEqual(['gardening', 'shopping', 'tools']);

    // Nothing left to delete: no note changes.
    expect(notebook.deleteTag({ tag: 'garden' }).notes).toEqual([]);
    expect(() => notebook.deleteTag({ tag: 'not a tag' })).toThrow(/valid tag/);
  });
});
