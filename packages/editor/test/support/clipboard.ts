import { schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import type { CollabEditor } from '../../src/collab';

/** A DataTransfer stand-in (happy-dom's holds no custom types or files). */
export class FakeDataTransfer {
  readonly data = new Map<string, string>();
  constructor(
    entries: Record<string, string> = {},
    readonly files: File[] = [],
  ) {
    for (const [type, value] of Object.entries(entries)) if (value) this.data.set(type, value);
  }
  get types(): string[] {
    return [...this.data.keys()];
  }
  getData(type: string): string {
    return this.data.get(type) ?? '';
  }
  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
  clearData(): void {
    this.data.clear();
  }
}

/** A clipboard event carrying `data` (as a browser's paste, copy or cut event does). */
export function clipboardEvent(
  type: 'paste' | 'copy' | 'cut',
  data: FakeDataTransfer,
): ClipboardEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: data });
  return event;
}

/** Pastes clipboard entries into the editor (at its selection), as the browser would. */
export function paste(
  collab: CollabEditor,
  entries: Record<string, string>,
  files: File[] = [],
): ClipboardEvent {
  const event = clipboardEvent('paste', new FakeDataTransfer(entries, files));
  collab.editor.view.dom.dispatchEvent(event);
  return event;
}

/** Presses ⌘⇧V (paste and match style) so the next paste is plain. */
export function pressPastePlain(collab: CollabEditor): void {
  collab.editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'V',
      code: 'KeyV',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** Copies (or cuts) the editor's selection and returns what went on the clipboard. */
export function copy(collab: CollabEditor, type: 'copy' | 'cut' = 'copy'): FakeDataTransfer {
  const data = new FakeDataTransfer();
  collab.editor.view.dom.dispatchEvent(clipboardEvent(type, data));
  return data;
}

/** The editor's document as markdown, through the core codec. */
export function markdownOf(collab: CollabEditor): string {
  return serializeMarkdown({
    frontmatter: null,
    doc: coreSchema.nodeFromJSON(collab.editor.getJSON()),
  });
}
