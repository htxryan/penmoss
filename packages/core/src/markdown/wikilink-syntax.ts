import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type {
  Handle as ToMarkdownHandle,
  Options as ToMarkdownExtension,
} from 'mdast-util-to-markdown';
import { markdownLineEnding } from 'micromark-util-character';
import type {
  Code,
  Construct,
  Extension,
  State,
  TokenizeContext,
  Tokenizer,
} from 'micromark-util-types';
import type { WikiEmbed, WikiLink, WikiReference } from './mdast-types';
import { fromTableCell, toTableCell } from './table-pipes';

const EXCLAMATION = 33;
const LEFT_BRACKET = 91;
const BACKSLASH = 92;
const RIGHT_BRACKET = 93;

function wikiTokenizer(kind: 'wikiLink' | 'wikiEmbed'): Tokenizer {
  return function tokenize(this: TokenizeContext, effects, ok, nok) {
    let size = 0;
    return start;

    function start(code: Code): State | undefined {
      effects.enter(kind);
      effects.enter('wikiLinkMarker');
      if (kind === 'wikiEmbed') {
        effects.consume(code);
        return openFirst;
      }
      return openFirst(code);
    }

    function openFirst(code: Code): State | undefined {
      if (code !== LEFT_BRACKET) return nok(code);
      effects.consume(code);
      return openSecond;
    }

    function openSecond(code: Code): State | undefined {
      if (code !== LEFT_BRACKET) return nok(code);
      effects.consume(code);
      effects.exit('wikiLinkMarker');
      effects.enter('wikiLinkData');
      return inside;
    }

    function inside(code: Code): State | undefined {
      if (code === null || markdownLineEnding(code) || code === LEFT_BRACKET) return nok(code);
      if (code === RIGHT_BRACKET) {
        if (size === 0) return nok(code);
        effects.exit('wikiLinkData');
        effects.enter('wikiLinkMarker');
        effects.consume(code);
        return closeSecond;
      }
      effects.consume(code);
      size++;
      return code === BACKSLASH ? escaped : inside;
    }

    function escaped(code: Code): State | undefined {
      if (code === null || markdownLineEnding(code)) return nok(code);
      effects.consume(code);
      size++;
      return inside;
    }

    function closeSecond(code: Code): State | undefined {
      if (code !== RIGHT_BRACKET) return nok(code);
      effects.consume(code);
      effects.exit('wikiLinkMarker');
      effects.exit(kind);
      return ok;
    }
  };
}

const wikiLinkConstruct: Construct = { name: 'wikiLink', tokenize: wikiTokenizer('wikiLink') };
const wikiEmbedConstruct: Construct = { name: 'wikiEmbed', tokenize: wikiTokenizer('wikiEmbed') };

/** micromark syntax for `[[…]]` links and `![[…]]` embeds (no nesting, single line). */
export function wikiLinkSyntax(): Extension {
  return { text: { [LEFT_BRACKET]: wikiLinkConstruct, [EXCLAMATION]: wikiEmbedConstruct } };
}

/** Characters a backslash escapes inside `[[…]]`. */
const ESCAPABLE = new Set(['\\', '[', ']', '|', '#']);

/**
 * Splits `target#heading|alias`. A backslash escapes `\ [ ] | #`, so titles
 * can contain them; before any other character it is literal. The first
 * unescaped `#` in the target starts the heading and the first unescaped `|`
 * starts the alias. In a table cell, GFM needs every `|` escaped: there `\|`
 * is the alias separator, as Obsidian writes it (see `fromTableCell`).
 */
export function parseWikiReference(raw: string, inTableCell = false): WikiReference {
  const source = inTableCell ? fromTableCell(raw) : raw;
  const parts: { target: string; heading: string | null; alias: string | null } = {
    target: '',
    heading: null,
    alias: null,
  };
  let part: 'target' | 'heading' | 'alias' = 'target';
  for (let i = 0; i < source.length; i++) {
    let char = source[i]!;
    const next = source[i + 1];
    if (char === '\\' && next !== undefined && ESCAPABLE.has(next)) {
      char = next;
      i++;
    } else if (char === '|' && part !== 'alias') {
      part = 'alias';
      parts.alias = '';
      continue;
    } else if (char === '#' && part === 'target') {
      part = 'heading';
      parts.heading = '';
      continue;
    }
    parts[part] = (parts[part] ?? '') + char;
  }
  return parts;
}

/** Escapes one part of a reference. `#` only needs escaping in the target. */
function escapePart(value: string, escapeHash: boolean): string {
  const text = value.replace(/[\r\n]+/g, ' ');
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const next = text[i + 1];
    if (char === '\\') {
      // Literal unless it would escape what follows (or the `#`, `|`, `]]` after the part).
      out += next === undefined || ESCAPABLE.has(next) ? '\\\\' : '\\';
    } else if (char === '[' || char === ']' || char === '|' || (char === '#' && escapeHash)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return out;
}

/** Writes `target#heading|alias`, escaping markup characters (see `parseWikiReference`). */
export function formatWikiReference(reference: WikiReference, inTableCell: boolean): string {
  let text = escapePart(reference.target, true);
  if (reference.heading !== null) text += `#${escapePart(reference.heading, false)}`;
  if (reference.alias !== null) text += `|${escapePart(reference.alias, false)}`;
  return inTableCell ? toTableCell(text) : text;
}

export function wikiLinkFromMarkdown(): FromMarkdownExtension {
  return {
    enter: {
      wikiLink(token) {
        const node: WikiLink = { type: 'wikiLink', target: '', heading: null, alias: null };
        this.enter(node, token);
      },
      wikiEmbed(token) {
        const node: WikiEmbed = { type: 'wikiEmbed', target: '', heading: null, alias: null };
        this.enter(node, token);
      },
    },
    exit: {
      wikiLinkData(token) {
        const node = this.stack[this.stack.length - 1] as WikiLink | WikiEmbed;
        const inTableCell = this.stack.some((parent) => parent.type === 'tableCell');
        Object.assign(node, parseWikiReference(this.sliceSerialize(token), inTableCell));
      },
      wikiLink(token) {
        this.exit(token);
      },
      wikiEmbed(token) {
        this.exit(token);
      },
    },
  };
}

const handleWikiLink: ToMarkdownHandle = (node: WikiLink, _parent, state) =>
  `[[${formatWikiReference(node, state.stack.includes('tableCell'))}]]`;

const handleWikiEmbed: ToMarkdownHandle = (node: WikiEmbed, _parent, state) =>
  `![[${formatWikiReference(node, state.stack.includes('tableCell'))}]]`;

export function wikiLinkToMarkdown(): ToMarkdownExtension {
  return { handlers: { wikiLink: handleWikiLink, wikiEmbed: handleWikiEmbed } };
}
