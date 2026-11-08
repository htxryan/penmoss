import { schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import { DOMParser as PMDOMParser, DOMSerializer, Slice } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';
import { linkMenuOf } from '../src/extensions/link-menu';
import { openEditor, paragraph, press, type } from './support/editor';
import { fakeLinks } from './support/links';

type Collab = ReturnType<typeof openEditor>;

const markdownOf = (collab: Collab) =>
  serializeMarkdown({ frontmatter: null, doc: coreSchema.nodeFromJSON(collab.editor.getJSON()) });

const linksIn = (collab: Collab) => {
  const found: Record<string, unknown>[] = [];
  collab.editor.state.doc.descendants((node) => {
    if (node.type.name === 'wikilink') found.push({ ...node.attrs });
  });
  return found;
};

const anchors = (collab: Collab) => [
  ...collab.editor.view.dom.querySelectorAll<HTMLAnchorElement>('a.pm-wikilink'),
];

const notes = { n1: 'Garden plan', n2: 'Grocery list', n3: 'Penmoss — sync design' };

describe('[[ completion', () => {
  it('opens on [[, ranks notes fuzzily from the registry, and links the chosen one by id', () => {
    const { services } = fakeLinks(notes);
    const collab = openEditor([paragraph()], { links: services });
    const { view } = collab.editor;

    type(view, 'See [[gpl');
    const menu = linkMenuOf(collab.editor)!;
    expect(menu.isOpen).toBe(true);
    expect(menu.shown[0]).toMatchObject({ kind: 'note', id: 'n1', title: 'Garden plan' });
    expect(press(view, 'Enter')).toBe(true);
    type(view, 'today');

    expect(menu.isOpen).toBe(false);
    expect(linksIn(collab)).toEqual([
      { noteId: 'n1', target: 'Garden plan', heading: null, alias: null },
    ]);
    expect(markdownOf(collab)).toBe('See [[Garden plan]] today\n');
  });

  it('offers to create a note when no title matches, offline from the registry', () => {
    const { services } = fakeLinks(notes);
    const collab = openEditor([paragraph()], { links: services });
    const { view } = collab.editor;

    type(view, '[[Holiday ideas');
    const menu = linkMenuOf(collab.editor)!;
    expect(menu.shown.at(-1)).toEqual({ kind: 'create', title: 'Holiday ideas' });
    press(view, 'ArrowUp'); // Wraps to the last option.
    press(view, 'Enter');

    expect(services.create).toHaveBeenCalledWith('Holiday ideas');
    expect(linksIn(collab)).toEqual([
      { noteId: 'new1', target: 'Holiday ideas', heading: null, alias: null },
    ]);
  });

  it('completes headings after # and keeps an alias after |', async () => {
    const { services } = fakeLinks(notes, { n1: ['Beds', 'Watering schedule'] });
    const collab = openEditor([paragraph()], { links: services });
    const { view } = collab.editor;

    type(view, '[[Garden plan#wat');
    const menu = linkMenuOf(collab.editor)!;
    await vi.waitFor(() =>
      expect(menu.shown).toEqual([
        { kind: 'heading', id: 'n1', title: 'Garden plan', heading: 'Watering schedule' },
        { kind: 'heading', id: 'n1', title: 'Garden plan', heading: 'wat' },
      ]),
    );
    press(view, 'Enter');
    expect(linksIn(collab)[0]).toEqual({
      noteId: 'n1',
      target: 'Garden plan',
      heading: 'Watering schedule',
      alias: null,
    });

    type(view, '[[groc|the list');
    press(view, 'Enter');
    expect(linksIn(collab)[1]).toEqual({
      noteId: 'n2',
      target: 'Grocery list',
      heading: null,
      alias: 'the list',
    });
    expect(markdownOf(collab)).toBe(
      '[[Garden plan#Watering schedule]] [[Grocery list|the list]]\n',
    );
  });

  it('makes a link from a whole [[Title]] typed out, resolved by title', () => {
    const { services } = fakeLinks(notes);
    const collab = openEditor([paragraph()], { links: services });

    type(collab.editor.view, 'a [[grocery list]] and [[Nowhere]]');

    expect(linksIn(collab)).toEqual([
      { noteId: 'n2', target: 'grocery list', heading: null, alias: null },
      { noteId: null, target: 'Nowhere', heading: null, alias: null },
    ]);
  });

  it('stays closed in code and for a [[ the user did not type', () => {
    const { services } = fakeLinks(notes);
    const collab = openEditor([paragraph()], { links: services });
    collab.editor.commands.toggleCode();
    type(collab.editor.view, '[[x');
    expect(linkMenuOf(collab.editor)?.isOpen ?? false).toBe(false);
  });
});

describe('a wikilink', () => {
  it('shows the current title and follows renames without writing to the note', () => {
    const registry = fakeLinks(notes);
    const collab = openEditor(
      [
        {
          type: 'paragraph',
          content: [
            { type: 'wikilink', attrs: { noteId: 'n1', target: 'Garden plan' } },
            { type: 'text', text: ' ' },
            {
              type: 'wikilink',
              attrs: { noteId: 'n2', target: 'Grocery list', alias: 'shopping' },
            },
            { type: 'text', text: ' ' },
            { type: 'wikilink', attrs: { noteId: 'n1', target: 'Garden plan', heading: 'Beds' } },
          ],
        },
      ],
      { links: registry.services },
    );
    const writes = vi.fn();
    collab.replica.onUpdate(writes);

    expect(anchors(collab).map((a) => a.textContent)).toEqual([
      'Garden plan',
      'shopping',
      'Garden plan › Beds',
    ]);
    registry.rename('n1', 'Allotment');
    expect(anchors(collab).map((a) => a.textContent)).toEqual([
      'Allotment',
      'shopping',
      'Allotment › Beds',
    ]);
    expect(writes).not.toHaveBeenCalled();
  });

  it('shows as broken while its note is deleted, and comes back on undelete', () => {
    const registry = fakeLinks(notes);
    const collab = openEditor(
      [
        {
          type: 'paragraph',
          content: [{ type: 'wikilink', attrs: { noteId: 'n2', target: 'Grocery list' } }],
        },
      ],
      { links: registry.services },
    );
    const [anchor] = anchors(collab);

    registry.rename('n2', null);
    expect(anchor!.dataset['state']).toBe('broken');
    expect(anchor!.textContent).toBe('Grocery list');
    registry.rename('n2', 'Grocery list (2026)');
    expect(anchor!.dataset['state']).toBe('resolved');
    expect(anchor!.textContent).toBe('Grocery list (2026)');
  });

  it('opens its note on click and on Enter; an unresolved one creates the note first', () => {
    const { services } = fakeLinks(notes);
    const collab = openEditor(
      [
        {
          type: 'paragraph',
          content: [
            { type: 'wikilink', attrs: { noteId: 'n1', target: 'Garden plan', heading: 'Beds' } },
            { type: 'text', text: ' ' },
            { type: 'wikilink', attrs: { noteId: null, target: 'Later' } },
          ],
        },
      ],
      { links: services },
    );
    const { view } = collab.editor;
    const second = anchors(collab)[1];

    view.someProp('handleClickOn', (handle) =>
      handle(view, 1, view.state.doc.nodeAt(1)!, 1, new MouseEvent('click', { button: 0 }), true),
    );
    expect(services.open).toHaveBeenLastCalledWith('n1', 'Beds', 'here');
    // ⌘ or Ctrl: a new tab; ⌥ (Alt): a new window (T45, A710), never the browser's download.
    const modified = (init: MouseEventInit) =>
      new MouseEvent('click', { button: 0, cancelable: true, ...init });
    for (const [init, where] of [
      [{ metaKey: true }, 'tab'],
      [{ ctrlKey: true }, 'tab'],
      [{ altKey: true }, 'window'],
    ] as const) {
      const click = modified(init);
      view.someProp('handleClickOn', (handle) =>
        handle(view, 1, view.state.doc.nodeAt(1)!, 1, click, true),
      );
      expect(services.open).toHaveBeenLastCalledWith('n1', 'Beds', where);
      expect(click.defaultPrevented).toBe(true);
    }
    // The anchor's own click, after the release that followed it, does nothing either: an
    // ⌥-click would download the link.
    const native = new MouseEvent('click', {
      button: 0,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    anchors(collab)[0]!.dispatchEvent(native);
    expect(native.defaultPrevented).toBe(true);

    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 3)));
    expect(press(view, 'Enter')).toBe(true);
    expect(services.create).toHaveBeenCalledWith('Later');
    expect(services.open).toHaveBeenLastCalledWith('new1', null, 'here');
    expect(linksIn(collab)[1]).toMatchObject({ noteId: 'new1', target: 'Later' });
    expect(second!.dataset['state']).toBe('resolved');
  });

  it('keeps its note id through copy and paste as HTML', () => {
    const { services } = fakeLinks(notes);
    const collab = openEditor(
      [
        {
          type: 'paragraph',
          content: [
            {
              type: 'wikilink',
              attrs: { noteId: 'n3', target: 'Sync', heading: 'Merge', alias: 'merging' },
            },
          ],
        },
      ],
      { links: services },
    );
    const { schema } = collab.editor;
    const html = document.createElement('div');
    html.append(
      DOMSerializer.fromSchema(schema).serializeFragment(collab.editor.state.doc.content),
    );

    expect(html.querySelector('a')!.textContent).toBe('merging');
    const parsed = PMDOMParser.fromSchema(schema).parseSlice(html);
    expect(parsed).toBeInstanceOf(Slice);
    expect(parsed.content.firstChild!.firstChild!.attrs).toEqual({
      noteId: 'n3',
      target: 'Sync',
      heading: 'Merge',
      alias: 'merging',
    });
    expect(collab.editor.getText()).toBe('[[Sync#Merge|merging]]');
  });

  it('is offered in the slash menu when there is a registry', () => {
    const { services } = fakeLinks(notes);
    const collab = openEditor([paragraph()], { links: services });
    const { view } = collab.editor;
    type(view, '/link to');
    press(view, 'Enter');
    expect(linkMenuOf(collab.editor)?.isOpen).toBe(true);
    expect(view.state.doc.textContent).toBe('[[');
  });
});
