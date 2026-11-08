import { schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import { DOMParser as PMDOMParser, DOMSerializer } from '@tiptap/pm/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insertFiles, openFile, type FileServices } from '../src/extensions/attachment';
import { availableBlockItems } from '../src/extensions/block-items';
import { openEditor, paragraph } from './support/editor';

const SHA = 'c'.repeat(64);
const PDF = `attachments/${SHA}.pdf`;
const CSV = `attachments/${'d'.repeat(64)}.csv`;

function files(overrides: Partial<FileServices> = {}) {
  return {
    add: vi.fn(() => Promise.resolve({ path: `attachments/${'e'.repeat(64)}.png` })),
    addFile: vi.fn((file: File) =>
      Promise.resolve({ path: file.name.endsWith('.pdf') ? PDF : CSV }),
    ),
    info: vi.fn((src: string) =>
      Promise.resolve(
        src === PDF
          ? { size: 1536, type: 'application/pdf' }
          : { size: 20 * 1024 * 1024, type: 'application/octet-stream' },
      ),
    ),
    resolve: vi.fn((src: string) => Promise.resolve(`blob:test/${src}`)),
    release: vi.fn<(src: string) => void>(),
    onError: vi.fn<(message: string) => void>(),
    ...overrides,
  } satisfies FileServices;
}

const chip = (name: string, href: string) => ({
  type: 'paragraph',
  content: [
    { type: 'text', text: 'See ' },
    { type: 'attachment', attrs: { href, name } },
  ],
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const chips = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>('[data-testid="attachment"]'),
];
const visible = (element: HTMLElement) =>
  [...element.querySelectorAll<HTMLButtonElement>('button')]
    .filter((button) => !button.hidden)
    .map((button) => button.textContent);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attachment chips', () => {
  it('show the name, type and size, with Preview and Open for PDFs only', async () => {
    const services = files();
    const collab = openEditor([chip('Q3 report.pdf', PDF), chip('budget.csv', CSV)], {
      files: services,
    });
    await settle();

    const [pdf, csv] = chips(collab.editor.view.dom);
    expect(pdf!.querySelector('.pm-attachment-badge')!.textContent).toBe('PDF');
    expect(pdf!.querySelector('.pm-attachment-name')!.textContent).toBe('Q3 report.pdf');
    expect(pdf!.querySelector('.pm-attachment-size')!.textContent).toBe('1.5 KB');
    expect(visible(pdf!)).toEqual(['Preview', 'Open', 'Download']);
    expect(csv!.querySelector('.pm-attachment-badge')!.textContent).toBe('CSV');
    expect(csv!.querySelector('.pm-attachment-size')!.textContent).toBe('20 MB');
    expect(visible(csv!)).toEqual(['Download']);
    // Nothing is fetched until asked.
    expect(services.resolve).not.toHaveBeenCalled();
  });

  it('offers Preview and Open only for a file stored as a PDF, whatever its name says', async () => {
    const NAMED = `attachments/${'f'.repeat(64)}.pdf`;
    let answer: (info: { size: number; type: string }) => void = () => undefined;
    const services = files({
      info: vi.fn(
        () =>
          new Promise<{ size: number; type: string }>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const collab = openEditor([chip('fake.pdf', NAMED)], { files: services });
    await settle();
    const [named] = chips(collab.editor.view.dom);
    // Before its type is known, and after it turns out not to be a PDF: download only.
    expect(visible(named!)).toEqual(['Download']);
    answer({ size: 10, type: 'application/octet-stream' });
    await settle();
    expect(visible(named!)).toEqual(['Download']);
  });

  it('downloads under the file’s name, previews a PDF inline, and never writes to the note', async () => {
    const services = files();
    const collab = openEditor([chip('Q3 report.pdf', PDF)], { files: services });
    const before = collab.editor.getJSON();
    const transactions = vi.fn();
    collab.editor.on('transaction', transactions);
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const [pdf] = chips(collab.editor.view.dom);

    pdf!.querySelector<HTMLButtonElement>('.pm-attachment-download')!.click();
    await settle();
    expect(clicked.map((a) => [a.download, a.getAttribute('href')])).toEqual([
      ['Q3 report.pdf', `blob:test/${PDF}`],
    ]);

    pdf!.querySelector<HTMLButtonElement>('.pm-attachment-preview')!.click();
    await settle();
    const frame = pdf!.querySelector<HTMLIFrameElement>('iframe')!;
    expect(frame.getAttribute('src')).toBe(`blob:test/${PDF}`);
    expect(frame.title).toBe('Preview of Q3 report.pdf');
    pdf!.querySelector<HTMLButtonElement>('.pm-attachment-preview')!.click();
    expect(pdf!.querySelector('iframe')).toBeNull();

    expect(transactions).not.toHaveBeenCalled();
    expect(collab.editor.getJSON()).toEqual(before);
    // One URL held per chip, given back when the chip goes.
    collab.editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(services.release).toHaveBeenCalledWith(PDF);
    expect(services.resolve).toHaveBeenCalledTimes(2);
    expect(services.release).toHaveBeenCalledTimes(2);
  });

  it('says so when the file is not on this device and cannot be fetched', async () => {
    const services = files({ resolve: vi.fn(() => Promise.resolve(null)) });
    const collab = openEditor([chip('remote.csv', CSV)], { files: services });
    const [csv] = chips(collab.editor.view.dom);

    csv!.querySelector<HTMLButtonElement>('.pm-attachment-download')!.click();
    await settle();

    expect(csv!.dataset['state']).toBe('missing');
    expect(services.onError).toHaveBeenCalledWith(
      '“remote.csv” is not available yet: it downloads once online.',
    );
  });
});

describe('attachment chips in an app shell (T40 P8, ED12)', () => {
  it('offer Open and Save a copy for every file, with no preview, and hand both to the shell', async () => {
    const openFile = vi.fn<(src: string, name: string, action: 'open' | 'save') => void>();
    const services = files({ openFile });
    const collab = openEditor([chip('Q3 report.pdf', PDF), chip('budget.csv', CSV)], {
      files: services,
    });
    await settle();

    const [pdf, csv] = chips(collab.editor.view.dom);
    expect(visible(pdf!)).toEqual(['Open', 'Save a Copy']);
    expect(visible(csv!)).toEqual(['Open', 'Save a Copy']);
    expect(pdf!.querySelector('.pm-attachment-open')!.getAttribute('aria-label')).toBe(
      'Open Q3 report.pdf',
    );
    expect(csv!.querySelector('.pm-attachment-download')!.getAttribute('aria-label')).toBe(
      'Save a Copy of budget.csv',
    );
    const before = JSON.stringify(collab.editor.getJSON());

    pdf!.querySelector<HTMLButtonElement>('.pm-attachment-open')!.click();
    csv!.querySelector<HTMLButtonElement>('.pm-attachment-download')!.click();
    await settle();

    expect(openFile.mock.calls).toEqual([
      [PDF, 'Q3 report.pdf', 'open'],
      [CSV, 'budget.csv', 'save'],
    ]);
    // The shell reads the file itself: the page never fetches it, and the note is unchanged.
    expect(services.resolve).not.toHaveBeenCalled();
    expect(pdf!.querySelector('iframe')).toBeNull();
    expect(JSON.stringify(collab.editor.getJSON())).toBe(before);
  });

  it('opens a file inside an embed through the shell too', async () => {
    const shell = vi.fn<(src: string, name: string, action: 'open' | 'save') => void>();
    const services = files({ openFile: shell });
    await openFile(services, document, CSV, 'budget.csv');
    expect(shell).toHaveBeenCalledWith(CSV, 'budget.csv', 'open');
    expect(services.resolve).not.toHaveBeenCalled();
  });
});

describe('adding files', () => {
  it('stores each file and inserts images as images and anything else as a chip', async () => {
    const services = files();
    const collab = openEditor([paragraph('Files: ')], { files: services, images: services });
    const pdf = new File([new TextEncoder().encode('%PDF-1.7')], 'Q3 report.pdf', {
      type: 'application/pdf',
    });
    const png = new File([new Uint8Array([0x89, 0x50])], 'shot.png', { type: 'image/png' });

    await insertFiles(collab.editor.view, services, [pdf, png], 8);

    expect(services.addFile).toHaveBeenCalledWith(pdf);
    expect(services.add).toHaveBeenCalledTimes(1);
    const inline: { type: { name: string }; attrs: Record<string, unknown> }[] = [];
    collab.editor.state.doc.firstChild!.forEach((node) => inline.push(node));
    expect(inline.map((node) => node.type.name)).toEqual(['text', 'attachment', 'image']);
    expect(inline[1]!.attrs).toEqual({ href: PDF, name: 'Q3 report.pdf' });
    expect(
      serializeMarkdown({
        frontmatter: null,
        doc: coreSchema.nodeFromJSON(collab.editor.getJSON()),
      }),
    ).toBe(`Files: [Q3 report.pdf](${PDF})![](attachments/${'e'.repeat(64)}.png)\n`);
  });

  it('reports a refused file and goes on with the rest', async () => {
    const services = files({
      addFile: vi.fn((file: File) =>
        file.name === 'huge.mov'
          ? Promise.reject(new Error('“huge.mov” is over 50 MB, the largest file Penmoss stores'))
          : Promise.resolve({ path: CSV }),
      ),
    });
    const collab = openEditor([paragraph()], { files: services });
    const huge = new File(['x'], 'huge.mov');
    const csv = new File(['a,b'], 'data.csv', { type: 'text/csv' });

    await insertFiles(collab.editor.view, services, [huge, csv], 1);

    expect(services.onError).toHaveBeenCalledWith(
      '“huge.mov” is over 50 MB, the largest file Penmoss stores',
    );
    expect(chips(collab.editor.view.dom)).toHaveLength(1);
  });

  it('keeps the file through copy and paste between notes', () => {
    const collab = openEditor([chip('Q3 report.pdf', PDF)], { files: files() });
    const { schema } = collab.editor;
    const html = document.createElement('div');
    html.append(
      DOMSerializer.fromSchema(schema).serializeFragment(collab.editor.state.doc.content),
    );

    const anchor = html.querySelector('a[data-attachment]')!;
    expect(anchor.textContent).toBe('Q3 report.pdf');
    const parsed = PMDOMParser.fromSchema(schema).parseSlice(html);
    expect(parsed.content.firstChild!.lastChild!.type.name).toBe('attachment');
    expect(parsed.content.firstChild!.lastChild!.attrs).toEqual({
      href: PDF,
      name: 'Q3 report.pdf',
    });
  });

  it('is offered in the slash menu only with file storage', () => {
    const collab = openEditor();
    expect(availableBlockItems(collab.editor).map((item) => item.id)).not.toContain('file');
    expect(
      availableBlockItems(collab.editor, undefined, undefined, files()).map((item) => item.id),
    ).toContain('file');
  });
});
