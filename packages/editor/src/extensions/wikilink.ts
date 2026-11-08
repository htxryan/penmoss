/**
 * Wikilinks (T16). The model is core's `wikilink` atom (A9): the target
 * note's id, the target as written, and an optional heading and alias. The
 * id is what the link means, so a rename never breaks it: the view shows the
 * note's current title from `LinkServices`, and re-renders when titles change
 * (DOM only; rendering never writes to the document). A link whose note is
 * unknown or deleted shows as broken, and comes back when the note does.
 *
 * Typing `[[` opens note completion (`link-menu.ts`); typing a whole
 * `[[Title]]` makes a link to the note with that title. A click on a link,
 * or Enter on a selected one, opens its note; an unresolved link creates the
 * note first.
 */
import { formatWikiReference, parseWikiReference } from '@penmoss/core/wikilinks';
import { linkLabel, linkRefOf, type DocJson, type LinkRef } from '@penmoss/core/links';
import { InputRule, Node, type Attributes } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { linkMenuPlugin } from './link-menu';

/** A note offered by `[[` completion. */
export interface NoteCandidate {
  readonly id: string;
  readonly title: string;
  /** Shown after the title, such as the note's folder. */
  readonly detail?: string;
}

/** What links need from the app: the note registry, offline included. */
export interface LinkServices {
  /** The note's current title (non-empty), or null when it is unknown or deleted. */
  title(noteId: string): string | null;
  /** Notes matching a query, best first (fuzzy, from the local registry). */
  search(query: string, limit: number): readonly NoteCandidate[];
  /** The note titled `title` (ignoring case), or null. */
  resolve(title: string): string | null;
  /** Creates a note titled `title` and returns its id, or null when it cannot. */
  create(title: string): string | null;
  /**
   * Opens a note, at a heading when given: here, in a new tab (a ⌘- or Ctrl-click, a middle
   * click) or in a new window (an ⌥- or Alt-click, T45).
   */
  open(noteId: string, heading: string | null, where?: OpenWhere): void;
  /** The note's headings, for `[[Title#` completion. */
  headings?(noteId: string): Promise<readonly string[]>;
  /** Called whenever a title may have changed. */
  subscribe(listener: () => void): () => void;
  /** The note this editor shows: an embed of it (or of a note embedding it) is a cycle (T13). */
  readonly noteId?: string | null;
  /** A note's body as ProseMirror JSON, for embeds (T13); null when this device lacks it. */
  body?(noteId: string): Promise<DocJson | null>;
  /** Follows a note's changes while an embed shows it (T13); returns the unsubscribe. */
  watch?(noteId: string, listener: () => void): () => void;
}

/** Where a followed link opens its note (T45): here, in a new tab, or in a new window. */
export type OpenWhere = 'here' | 'tab' | 'window';

/**
 * Where a click opens a link: ⌥ (Alt) a new window, ⌘ or Ctrl a new tab, else here (T45). The
 * caller calls `preventDefault`, as a browser's own ⌥-click on a link downloads it.
 */
export function openWhere(event: {
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}): OpenWhere {
  if (event.altKey && !event.metaKey && !event.ctrlKey) return 'window';
  return event.metaKey || event.ctrlKey ? 'tab' : 'here';
}

/** The path a link's anchor points at (for a middle click or Copy link). */
export const notePath = (noteId: string) => `/notes/${encodeURIComponent(noteId)}`;

const data = (name: string): Attributes[string] => ({
  parseHTML: (element: HTMLElement) => element.getAttribute(`data-${name}`) || null,
  renderHTML: (attrs: Record<string, unknown>) => {
    const value = attrs[name === 'note-id' ? 'noteId' : name];
    return typeof value === 'string' ? { [`data-${name}`]: value } : {};
  },
});

function wikilinkAttributes(): Attributes {
  return {
    noteId: data('note-id'),
    target: {
      ...data('target'),
      parseHTML: (element) =>
        element.getAttribute('data-target') ?? element.textContent?.trim() ?? '',
    },
    heading: data('heading'),
    alias: data('alias'),
  };
}

/** `[[target#heading|alias]]` as markdown (plain-text copy). */
export const referenceText = (ref: LinkRef, embed = false): string =>
  `${embed ? '!' : ''}[[${formatWikiReference(ref, false)}]]`;

/** The wikilink node; without services, links show what was written and do nothing on click. */
export function wikilinkExtension(services?: LinkServices) {
  return Node.create({
    name: 'wikilink',
    inline: true,
    group: 'inline',
    atom: true,
    addAttributes: wikilinkAttributes,
    // Clipboard HTML between notes keeps the id, so a pasted link still means the same note.
    // Ahead of the link mark's `a[href]` rule.
    parseHTML: () => [{ tag: 'a[data-wikilink]', priority: 60 }],
    renderHTML: ({ node, HTMLAttributes }) => {
      const ref = linkRefOf(node.attrs);
      return [
        'a',
        {
          ...HTMLAttributes,
          'data-wikilink': '',
          href: ref.noteId ? notePath(ref.noteId) : '#',
        },
        linkLabel(ref, ref.noteId ? (services?.title(ref.noteId) ?? null) : null),
      ];
    },
    renderText: ({ node }) => referenceText(linkRefOf(node.attrs)),
    addNodeView:
      () =>
      ({ node }) =>
        new WikilinkView(node, services),
    addInputRules() {
      return [
        new InputRule({
          // `[[Title]]` typed in full (not `![[…]]`, an embed).
          find: /(^|[^!])\[\[([^[\]\n]+)\]\]$/,
          handler: ({ state, range, match }) => {
            const ref = parseWikiReference(match[2]!);
            const target = ref.target.trim();
            if (!target) return;
            const node = state.schema.nodes['wikilink']!.create({
              noteId: services?.resolve(target) ?? null,
              target,
              heading: ref.heading?.trim() || null,
              alias: ref.alias?.trim() || null,
            });
            state.tr.replaceWith(range.from + match[1]!.length, range.to, node);
          },
        }),
      ];
    },
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => {
          const { selection } = editor.state;
          if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'wikilink') {
            return false;
          }
          return followLink(editor.view, selection.from, 'here', services);
        },
      };
    },
    addProseMirrorPlugins() {
      if (!services) return [];
      return [linkClickPlugin(services), linkMenuPlugin(this.editor, services)];
    },
  });
}

/**
 * Opens the link at `pos`. An unresolved link creates its note first and
 * points the link at it (a user action, so it may write).
 */
export function followLink(
  view: EditorView,
  pos: number,
  where: OpenWhere,
  services: LinkServices | undefined,
): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!services || node?.type.name !== 'wikilink') return false;
  const ref = linkRefOf(node.attrs);
  let noteId = ref.noteId;
  if (!noteId) {
    noteId = services.resolve(ref.target) ?? services.create(ref.target.trim());
    if (!noteId) return false;
    if (view.editable) {
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, noteId }));
    }
  }
  services.open(noteId, ref.heading, where);
  return true;
}

function linkClickPlugin(services: LinkServices): Plugin {
  return new Plugin({
    key: new PluginKey('penmossWikilinkClick'),
    props: {
      handleClickOn(view, _pos, node, nodePos, event, direct) {
        if (!direct || node.type.name !== 'wikilink' || event.button !== 0) return false;
        event.preventDefault();
        return followLink(view, nodePos, openWhere(event), services);
      },
      handleDOMEvents: {
        // The link opens on the press's release (handleClickOn); the anchor's own click must
        // do nothing after it: an ⌥-click would download it, a ⌘-click open a second tab (T45).
        click(_view, event) {
          const anchor = (event.target as Element | null)?.closest?.('a.pm-wikilink');
          if (anchor && event.button === 0) event.preventDefault();
          return false;
        },
        // A middle click would open the anchor's href as a page; open the note instead.
        auxclick(view, event) {
          const anchor = (event.target as Element | null)?.closest?.('a.pm-wikilink');
          if (!anchor || event.button !== 1) return false;
          const pos = view.posAtDOM(anchor, 0);
          event.preventDefault();
          return followLink(view, pos, 'tab', services);
        },
      },
    },
  });
}

/** One link: its current label, and whether its note exists. */
class WikilinkView implements NodeView {
  readonly dom: HTMLAnchorElement;
  private readonly off: (() => void) | undefined;

  constructor(
    private node: PMNode,
    private readonly services: LinkServices | undefined,
  ) {
    this.dom = document.createElement('a');
    this.dom.className = 'pm-wikilink';
    this.dom.contentEditable = 'false';
    this.dom.draggable = false;
    this.dom.dataset['testid'] = 'wikilink';
    this.render();
    this.off = services?.subscribe(() => this.render());
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.off?.();
  }

  private render(): void {
    const ref = linkRefOf(this.node.attrs);
    const title = ref.noteId ? (this.services?.title(ref.noteId) ?? null) : null;
    const state = !ref.noteId ? 'unresolved' : title === null ? 'broken' : 'resolved';
    const label = linkLabel(ref, title);
    if (this.dom.textContent !== label) this.dom.textContent = label;
    this.dom.dataset['state'] = state;
    if (ref.noteId) {
      this.dom.dataset['noteId'] = ref.noteId;
      this.dom.href = notePath(ref.noteId);
    } else {
      delete this.dom.dataset['noteId'];
      this.dom.removeAttribute('href');
    }
    this.dom.title =
      state === 'broken'
        ? `“${ref.target}” was deleted or is not on this device yet`
        : state === 'unresolved'
          ? `No note called “${ref.target}” yet: click to create it`
          : ref.alias || ref.heading
            ? `${title}${ref.heading ? ` › ${ref.heading}` : ''}`
            : '';
  }
}
