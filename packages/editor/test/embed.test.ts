import { schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import type { DocJson } from '@penmoss/core/links';
import { DOMParser as PMDOMParser, DOMSerializer } from '@tiptap/pm/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_URL_HOLD_MS, type FileServices } from '../src/extensions/attachment';
import { MAX_EMBED_DEPTH, resolveEmbed } from '../src/extensions/embed';
import { linkMenuOf } from '../src/extensions/link-menu';
import { openEditor, paragraph, press, type } from './support/editor';
import { fakeScreen } from './support/screen';
import { fakeLinks } from './support/links';

// Embeds follow notes only while on screen: here they are, unless a test says otherwise.
beforeEach(() => {
  fakeScreen();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const text = (value: string, marks?: DocJson['marks']): DocJson => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const para = (...content: DocJson[]): DocJson => ({ type: 'paragraph', content });
const heading = (level: number, value: string): DocJson => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});
const embedOf = (noteId: string | null, target: string, headingText: string | null = null) => ({
  type: 'embed',
  attrs: { noteId, target, heading: headingText, alias: null },
});
const doc = (...content: DocJson[]): DocJson => ({ type: 'doc', content });

const garden = doc(
  para(text('Raised beds.')),
  heading(2, 'Watering'),
  para(text('Every '), text('morning', [{ type: 'bold' }]), text('.')),
  heading(3, 'Drip lines'),
  para(text('Check weekly.')),
  heading(2, 'Harvest'),
  para(text('Late summer.')),
);

/** Lets the embed's async render (and its debounce) finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

describe('resolveEmbed', () => {
  const titles: Record<string, string> = { g: 'Garden', s: 'Shopping' };
  const services = {
    title: (id: string) => titles[id] ?? null,
    body: (id: string) => Promise.resolve(id === 'g' ? garden : id === 's' ? null : null),
  };
  const ref = (noteId: string | null, headingText: string | null = null) => ({
    noteId,
    target: 'Garden',
    heading: headingText,
    alias: null,
  });

  it('takes a heading’s section: up to the next heading of the same or a higher level', async () => {
    const resolved = await resolveEmbed(ref('g', 'watering'), ['host'], services);
    expect(resolved).toMatchObject({ kind: 'section', title: 'Garden' });
    const blocks = (resolved as { blocks: DocJson[] }).blocks;
    expect(blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'paragraph',
    ]);
    expect(blocks[0]!.content![0]!.text).toBe('Watering');
  });

  it('takes the whole note without a heading', async () => {
    const resolved = await resolveEmbed(ref('g'), ['host'], services);
    expect((resolved as { blocks: DocJson[] }).blocks).toHaveLength(7);
  });

  it('says why when there is nothing to show', async () => {
    expect(await resolveEmbed(ref(null), ['host'], services)).toEqual({ kind: 'unresolved' });
    expect(await resolveEmbed(ref('gone'), ['host'], services)).toEqual({
      kind: 'missing',
      title: null,
    });
    // Listed, but this device has no copy of its body yet.
    expect(await resolveEmbed(ref('s'), ['host'], services)).toEqual({
      kind: 'missing',
      title: 'Shopping',
    });
    expect(await resolveEmbed(ref('g', 'Pruning'), ['host'], services)).toEqual({
      kind: 'no-heading',
      title: 'Garden',
    });
  });

  it('detects cycles through the chain of notes around it, and limits depth', async () => {
    // A note embedding itself.
    expect(await resolveEmbed(ref('g'), ['g'], services)).toEqual({
      kind: 'cycle',
      title: 'Garden',
    });
    // host → x → g → … → g again.
    expect(await resolveEmbed(ref('g'), ['host', 'x', 'g', 'y'], services)).toMatchObject({
      kind: 'cycle',
    });
    const deep = Array.from({ length: MAX_EMBED_DEPTH + 1 }, (_, i) => `n${i}`);
    expect(await resolveEmbed(ref('g'), deep, services)).toMatchObject({ kind: 'too-deep' });
  });
});

describe('embed view', () => {
  it('renders the section read-only, with marks, and never writes to the note', async () => {
    const fake = fakeLinks({ g: 'Garden' }, {}, { noteId: 'host', bodies: { g: garden } });
    const collab = openEditor([paragraph('Intro'), embedOf('g', 'Garden', 'Watering')], {
      links: fake.services,
    });
    const before = collab.editor.getJSON();
    const transactions = vi.fn();
    collab.editor.on('transaction', transactions);
    await settle();

    const embed = collab.editor.view.dom.querySelector<HTMLElement>('[data-testid="embed"]')!;
    expect(embed.dataset['state']).toBe('ready');
    expect(embed.contentEditable).toBe('false');
    expect(embed.querySelector('.pm-embed-title')!.textContent).toBe('Garden › Watering');
    const body = embed.querySelector('.pm-embed-body')!;
    expect(body.querySelector('h2')!.textContent).toBe('Watering');
    expect(body.querySelector('strong')!.textContent).toBe('morning');
    expect(body.textContent).toContain('Check weekly.');
    expect(body.textContent).not.toContain('Late summer.');
    expect(fake.watched()).toEqual(['g']);
    expect(transactions).not.toHaveBeenCalled();
    expect(collab.editor.getJSON()).toEqual(before);
  });

  it('updates when the source note changes, and follows renames', async () => {
    const fake = fakeLinks({ g: 'Garden' }, {}, { noteId: 'host', bodies: { g: garden } });
    const collab = openEditor([embedOf('g', 'Garden', 'Harvest')], { links: fake.services });
    await settle();
    const embed = () => collab.editor.view.dom.querySelector<HTMLElement>('[data-testid="embed"]')!;
    expect(embed().textContent).toContain('Late summer.');

    fake.edit('g', doc(heading(2, 'Harvest'), para(text('Early autumn this year.'))));
    fake.rename('g', 'Allotment');
    await settle();

    expect(embed().textContent).toContain('Early autumn this year.');
    expect(embed().textContent).not.toContain('Late summer.');
    expect(embed().querySelector('.pm-embed-title')!.textContent).toBe('Allotment › Harvest');
  });

  it('renders nested embeds, and shows a cycle as a link instead', async () => {
    const fake = fakeLinks(
      { host: 'Weekly', a: 'Alpha', b: 'Beta' },
      {},
      {
        noteId: 'host',
        bodies: {
          a: doc(para(text('Alpha text.')), embedOf('b', 'Beta')),
          // Beta embeds Alpha back, and the host: both cycles.
          b: doc(para(text('Beta text.')), embedOf('a', 'Alpha'), embedOf('host', 'Weekly')),
        },
      },
    );
    const collab = openEditor([embedOf('a', 'Alpha')], { links: fake.services });
    await settle();

    const top = collab.editor.view.dom.querySelector<HTMLElement>('[data-testid="embed"]')!;
    expect(top.dataset['state']).toBe('ready');
    const nested = top.querySelectorAll<HTMLElement>('.pm-embed-nested');
    expect([...nested].map((box) => box.dataset['state'])).toEqual(['ready', 'cycle', 'cycle']);
    expect(nested[0]!.textContent).toContain('Beta text.');
    const cycles = [...nested].slice(1);
    expect(
      cycles.map((box) => box.querySelector('.pm-embed-notice a.pm-wikilink')!.textContent),
    ).toEqual(['Alpha', 'Weekly']);
    expect(cycles[0]!.textContent).toContain('Embedded in itself, so shown as a link');
    expect(fake.watched().sort()).toEqual(['a', 'b']);
  });

  it('shows a note embedding itself as a link', async () => {
    const fake = fakeLinks({ host: 'Weekly' }, {}, { noteId: 'host', bodies: {} });
    const collab = openEditor([embedOf('host', 'Weekly')], { links: fake.services });
    await settle();

    const embed = collab.editor.view.dom.querySelector<HTMLElement>('[data-testid="embed"]')!;
    expect(embed.dataset['state']).toBe('cycle');
    expect(embed.querySelector('.pm-embed-body a.pm-wikilink')!.textContent).toBe('Weekly');
    expect(fake.services.body).not.toHaveBeenCalled();
  });

  it('opens the source note from its title and from links inside', async () => {
    const fake = fakeLinks(
      { g: 'Garden', s: 'Seeds' },
      {},
      {
        noteId: 'host',
        bodies: {
          g: doc(
            para(text('Order '), {
              type: 'wikilink',
              attrs: { noteId: 's', target: 'Seeds', heading: null, alias: null },
            }),
          ),
        },
      },
    );
    const collab = openEditor([embedOf('g', 'Garden')], { links: fake.services });
    await settle();
    const embed = collab.editor.view.dom.querySelector<HTMLElement>('[data-testid="embed"]')!;

    embed.querySelector<HTMLElement>('.pm-embed-title')!.click();
    embed.querySelector<HTMLElement>('.pm-embed-body a[data-note-id="s"]')!.click();
    // ⌥-click: a note window (T45, A710).
    embed
      .querySelector<HTMLElement>('.pm-embed-title')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));

    expect(fake.services.open.mock.calls).toEqual([
      ['g', null, 'here'],
      ['s', null, 'here'],
      ['g', null, 'window'],
    ]);
  });
});

describe('inserting embeds', () => {
  it('![[ completes notes and inserts an embed block in place of the empty paragraph', async () => {
    const fake = fakeLinks(
      { g: 'Garden' },
      { g: ['Watering'] },
      { noteId: 'host', bodies: { g: garden } },
    );
    const collab = openEditor([paragraph()], { links: fake.services });
    const { view } = collab.editor;

    type(view, '![[gar');
    const menu = linkMenuOf(collab.editor)!;
    expect(menu.isOpen).toBe(true);
    expect(menu.shown.every((option) => option.kind !== 'create')).toBe(true);
    press(view, 'Enter');
    await settle();

    expect(collab.editor.getJSON().content.map((block) => block.type)).toEqual([
      'embed',
      'paragraph',
    ]);
    expect(collab.editor.getJSON().content[0]!.attrs).toMatchObject({
      noteId: 'g',
      target: 'Garden',
    });
  });

  it('turns a typed ![[Title#Heading]] line into an embed, and writes it back as markdown', () => {
    const fake = fakeLinks({ g: 'Garden' }, {}, { noteId: 'host', bodies: { g: garden } });
    const collab = openEditor([paragraph()], { links: fake.services });
    const { view } = collab.editor;
    linkMenuOf(collab.editor); // The menu may open; typing on closes it.

    type(view, '![[Garden#Watering]]');

    const json = collab.editor.getJSON();
    expect(json.content[0]).toMatchObject({
      type: 'embed',
      attrs: { noteId: 'g', target: 'Garden', heading: 'Watering' },
    });
    expect(serializeMarkdown({ frontmatter: null, doc: coreSchema.nodeFromJSON(json) })).toContain(
      '![[Garden#Watering]]',
    );
  });

  it('keeps its reference through copy and paste between notes', () => {
    const fake = fakeLinks({ g: 'Garden' }, {}, { noteId: 'host', bodies: { g: garden } });
    const collab = openEditor([embedOf('g', 'Garden', 'Watering')], { links: fake.services });
    const { schema } = collab.editor;
    const html = document.createElement('div');
    html.append(
      DOMSerializer.fromSchema(schema).serializeFragment(collab.editor.state.doc.content),
    );

    expect(html.textContent).toBe('![[Garden#Watering]]');
    const parsed = PMDOMParser.fromSchema(schema).parseSlice(html);
    expect(parsed.content.firstChild!.type.name).toBe('embed');
    expect(parsed.content.firstChild!.attrs).toEqual({
      noteId: 'g',
      target: 'Garden',
      heading: 'Watering',
      alias: null,
    });
  });
});

// Review follow-up: what embeds cost while a note is open.
describe('embed view: live updates', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const embeds = (root: HTMLElement) => [
    ...root.querySelectorAll<HTMLElement>('[data-testid="embed"]'),
  ];

  it('renders again when a title changes, not on every change to the note list', async () => {
    const fake = fakeLinks({ g: 'Garden' }, {}, { noteId: 'host', bodies: { g: garden } });
    const collab = openEditor([embedOf('g', 'Garden')], { links: fake.services });
    await settle();
    const reads = fake.services.body.mock.calls.length;

    fake.touch(); // Typing in the host note, or any other note, changes the list.
    fake.touch();
    await settle();
    expect(fake.services.body.mock.calls.length).toBe(reads);

    fake.rename('g', 'Allotment');
    await settle();
    expect(fake.services.body.mock.calls.length).toBeGreaterThan(reads);
    expect(embeds(collab.editor.view.dom)[0]!.querySelector('.pm-embed-title')!.textContent).toBe(
      'Allotment',
    );
  });

  it('follows only embeds on screen, and shows the rest from this device’s copy', async () => {
    const screen = fakeScreen({ offScreen: true });
    const fake = fakeLinks(
      { a: 'Alpha', b: 'Beta' },
      {},
      {
        noteId: 'host',
        bodies: { a: doc(para(text('Alpha text.'))), b: doc(para(text('Beta text.'))) },
      },
    );
    const collab = openEditor([embedOf('a', 'Alpha'), embedOf('b', 'Beta')], {
      links: fake.services,
    });
    await settle();
    const [first, second] = embeds(collab.editor.view.dom);
    expect(first!.textContent).toContain('Alpha text.');
    expect(second!.textContent).toContain('Beta text.');
    expect(fake.watched()).toEqual([]);

    screen.show(first!);
    await settle();
    expect(fake.watched()).toEqual(['a']);

    // Changed while off screen: shown once it scrolls into view.
    fake.edit('b', doc(para(text('Beta, edited.'))));
    screen.show(second!);
    await settle();
    expect(second!.textContent).toContain('Beta, edited.');
    expect(fake.watched().sort()).toEqual(['a', 'b']);

    screen.hide(first!);
    expect(fake.watched()).toEqual(['b']);
    collab.destroy();
    expect(fake.watched()).toEqual([]);
    expect(screen.observed()).toBe(0);
  });

  it('does not follow a note that is missing here, and renders it once it arrives', async () => {
    const bodies: Record<string, ReturnType<typeof doc>> = {};
    const fake = fakeLinks({ g: 'Garden' }, {}, { noteId: 'host', bodies });
    const collab = openEditor([embedOf('g', 'Garden'), embedOf('gone', 'Gone')], {
      links: fake.services,
    });
    await settle();
    expect(embeds(collab.editor.view.dom).map((embed) => embed.dataset['state'])).toEqual([
      'missing',
      'missing',
    ]);
    expect(fake.watched()).toEqual([]);

    // Catch-up sync stores the note: the list changes, and the embed shows it.
    fake.edit('g', garden);
    fake.touch();
    await settle();
    expect(embeds(collab.editor.view.dom)[0]!.dataset['state']).toBe('ready');
    expect(fake.watched()).toEqual(['g']);
  });

  it('opens an attached PDF in a new tab and downloads other files, then lets go of each URL', async () => {
    const PDF = `attachments/${'c'.repeat(64)}.pdf`;
    const CSV = `attachments/${'d'.repeat(64)}.csv`;
    const files = {
      add: vi.fn(() => Promise.resolve({ path: PDF })),
      addFile: vi.fn(() => Promise.resolve({ path: CSV })),
      info: vi.fn((src: string) =>
        Promise.resolve({
          size: 10,
          type: src === PDF ? 'application/pdf' : 'application/octet-stream',
        }),
      ),
      resolve: vi.fn((src: string) => Promise.resolve(`blob:test/${src}`)),
      release: vi.fn<(src: string) => void>(),
    } satisfies FileServices;
    const chip = (href: string, name: string) => ({ type: 'attachment', attrs: { href, name } });
    const fake = fakeLinks(
      { f: 'Files' },
      {},
      {
        noteId: 'host',
        bodies: { f: doc(para(chip(PDF, 'r.pdf'), text(' '), chip(CSV, 'b.csv'))) },
      },
    );
    const collab = openEditor([embedOf('f', 'Files')], { links: fake.services, files });
    await settle();
    const embed = embeds(collab.editor.view.dom)[0]!;
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const downloads: Array<{ href: string; download: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ href: this.href, download: this.download });
    });
    const click = (href: string) =>
      embed
        .querySelector(`a[data-href="${href}"]`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      click(PDF);
      click(CSV);
      await vi.advanceTimersByTimeAsync(0);
      expect(opened).toHaveBeenCalledWith(`blob:test/${PDF}`, '_blank', 'noopener');
      expect(downloads).toEqual([{ href: `blob:test/${CSV}`, download: 'b.csv' }]);
      expect(files.release).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(FILE_URL_HOLD_MS);
      expect(files.release.mock.calls).toEqual([[PDF], [CSV]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
