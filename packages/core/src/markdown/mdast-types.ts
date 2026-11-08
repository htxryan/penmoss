import type { BlockContent, Node, Parent, PhrasingContent } from 'mdast';

/** The parts of a `[[target#heading|alias]]` reference, as written. */
export interface WikiReference {
  target: string;
  heading: string | null;
  alias: string | null;
}

/** `[[Title]]`, `[[Title#Heading]]`, `[[Title|alias]]`. */
export interface WikiLink extends Node, WikiReference {
  type: 'wikiLink';
}

/** `![[Title#Heading]]`. */
export interface WikiEmbed extends Node, WikiReference {
  type: 'wikiEmbed';
}

/** `==highlighted==`. */
export interface Highlight extends Parent {
  type: 'highlight';
  children: PhrasingContent[];
}

/** An Obsidian callout (`> [!type]± Title`), produced only when serialising. */
export interface Callout extends Parent {
  type: 'callout';
  calloutType: string;
  title: string;
  foldable: boolean;
  collapsed: boolean;
  children: BlockContent[];
}

declare module 'mdast' {
  interface PhrasingContentMap {
    wikiLink: WikiLink;
    wikiEmbed: WikiEmbed;
    highlight: Highlight;
  }
  interface BlockContentMap {
    callout: Callout;
  }
  interface RootContentMap {
    wikiLink: WikiLink;
    wikiEmbed: WikiEmbed;
    highlight: Highlight;
    callout: Callout;
  }
}

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    wikiLink: 'wikiLink';
    wikiEmbed: 'wikiEmbed';
    wikiLinkMarker: 'wikiLinkMarker';
    wikiLinkData: 'wikiLinkData';
    highlight: 'highlight';
    highlightSequence: 'highlightSequence';
    highlightSequenceTemporary: 'highlightSequenceTemporary';
    highlightText: 'highlightText';
  }
}

declare module 'mdast-util-to-markdown' {
  interface ConstructNameMap {
    highlight: 'highlight';
    wikiLink: 'wikiLink';
    callout: 'callout';
  }
}
