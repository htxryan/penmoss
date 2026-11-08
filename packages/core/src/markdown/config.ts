import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFootnoteFromMarkdown, gfmFootnoteToMarkdown } from 'mdast-util-gfm-footnote';
import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown, gfmTableToMarkdown } from 'mdast-util-gfm-table';
import {
  gfmTaskListItemFromMarkdown,
  gfmTaskListItemToMarkdown,
} from 'mdast-util-gfm-task-list-item';
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';
import type { Options as ToMarkdownOptions } from 'mdast-util-to-markdown';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import { math } from 'micromark-extension-math';
import type { Extension as MicromarkExtension } from 'micromark-util-types';
import { calloutToMarkdown } from './callout-syntax';
import { highlightFromMarkdown, highlightSyntax, highlightToMarkdown } from './highlight-syntax';
import { textEscapingToMarkdown } from './text-escaping';
import { wikiLinkFromMarkdown, wikiLinkSyntax, wikiLinkToMarkdown } from './wikilink-syntax';

/**
 * The markdown dialect: CommonMark + GFM (tables, task lists, `~~strike~~`,
 * footnotes) + YAML frontmatter + `$math$` + Obsidian wikilinks, embeds,
 * `==highlight==` and callouts. GFM autolink literals are deliberately off, so
 * bare URLs stay text and round-trip byte for byte (ADR 0002).
 */
export const micromarkExtensions: MicromarkExtension[] = [
  frontmatter(['yaml']),
  gfmTable(),
  gfmStrikethrough({ singleTilde: false }),
  gfmTaskListItem(),
  gfmFootnote(),
  math(),
  wikiLinkSyntax(),
  highlightSyntax(),
];

export const fromMarkdownExtensions: FromMarkdownExtension[] = [
  frontmatterFromMarkdown(['yaml']),
  gfmTableFromMarkdown(),
  gfmStrikethroughFromMarkdown(),
  gfmTaskListItemFromMarkdown(),
  gfmFootnoteFromMarkdown(),
  mathFromMarkdown(),
  wikiLinkFromMarkdown(),
  highlightFromMarkdown(),
];

/** Serialisation choices; docs/markdown-normalisation.md describes each. */
export const toMarkdownOptions: ToMarkdownOptions = {
  bullet: '-',
  bulletOther: '*',
  bulletOrdered: '.',
  emphasis: '*',
  strong: '*',
  fence: '`',
  fences: true,
  rule: '-',
  ruleRepetition: 3,
  ruleSpaces: false,
  listItemIndent: 'one',
  incrementListMarker: true,
  closeAtx: false,
  setext: false,
  resourceLink: false,
  quote: '"',
  extensions: [
    gfmTableToMarkdown({ tablePipeAlign: false, tableCellPadding: true }),
    gfmStrikethroughToMarkdown(),
    gfmTaskListItemToMarkdown(),
    gfmFootnoteToMarkdown(),
    mathToMarkdown(),
    wikiLinkToMarkdown(),
    highlightToMarkdown(),
    calloutToMarkdown(),
    textEscapingToMarkdown(),
  ],
};
