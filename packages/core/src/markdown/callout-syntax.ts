import type { BlockContent, RootContent } from 'mdast';
import type { Handle, Options as ToMarkdownExtension } from 'mdast-util-to-markdown';
import type { Callout } from './mdast-types';

/** `> [!type]± Title` at the start of a blockquote's first paragraph line. */
export const CALLOUT_HEADER = /^\[!([^\]\s]+)\]([+-]?)(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * True when `node` can start on the line right after a paragraph line without
 * becoming part of that paragraph. Used to keep callout headers and tight list
 * items compact only where that is safe.
 */
export function interruptsParagraph(node: RootContent | undefined): boolean {
  if (!node) return false;
  switch (node.type) {
    case 'code':
    case 'math':
    case 'heading':
    case 'callout':
      return true;
    case 'blockquote': {
      // micromark lets a quote's first line interrupt the paragraph outside it only
      // if that line could itself interrupt a paragraph (`> 3. x` cannot).
      const first = node.children[0];
      return first?.type === 'list' || first?.type === 'blockquote'
        ? interruptsParagraph(first)
        : true;
    }
    case 'list': {
      if (node.ordered && (node.start ?? 1) !== 1) return false;
      const head = node.children[0]?.children[0];
      return head?.type === 'paragraph' && head.children.length > 0;
    }
    default:
      return false;
  }
}

/**
 * The callout type as the header can carry it: one run of characters with no
 * whitespace or `]` (see `CALLOUT_HEADER`). Those characters become `-`
 * (`my type` → `my-type`) and an empty type becomes `note`, so the header
 * always reads back as a callout.
 */
export function calloutType(type: string): string {
  return type.trim().replace(/[\s\]]+/g, '-') || 'note';
}

export function calloutHeader(
  node: Pick<Callout, 'calloutType' | 'title' | 'foldable' | 'collapsed'>,
): string {
  const fold = node.foldable ? (node.collapsed ? '-' : '+') : '';
  const title = node.title.replace(/[\r\n]+/g, ' ').trim();
  return `[!${calloutType(node.calloutType)}]${fold}${title ? ` ${title}` : ''}`;
}

const handleCallout: Handle = (node: Callout, _parent, state, info) => {
  const exit = state.enter('callout');
  const tracker = state.createTracker(info);
  tracker.move('> ');
  tracker.shift(2);
  const header = calloutHeader(node);
  const body = state.containerFlow(node, tracker.current());
  const first: BlockContent | undefined = node.children[0];
  const separator = first?.type === 'paragraph' || interruptsParagraph(first) ? '\n' : '\n\n';
  const value = body ? `${header}${separator}${body}` : header;
  exit();
  return state.indentLines(value, (line, _index, blank) => `>${blank ? '' : ' '}${line}`);
};

export function calloutToMarkdown(): ToMarkdownExtension {
  return { handlers: { callout: handleCallout } };
}
