/**
 * Every Lucide icon, for the icon picker (A1568): its name, its tags (what Lucide's site
 * searches) and its shapes, sorted by name. A chunk of its own, loaded as the picker opens.
 * From lucide-static's two files, so it shares no module with the one-icon chunks
 * (`lucide-icons.ts`) and the bundler keeps it one file. Lucide publishes no categories in its
 * packages, and its aliases only as names that resolve (`lucide-icons.ts`).
 */
import nodes from 'lucide-static/icon-nodes.json';
import tags from 'lucide-static/tags.json';
import type { Findable } from '@penmoss/core/glyph-search';
import type { IconNode } from './lucide';

export interface IconEntry extends Findable {
  /** Lucide's name, `notebook-pen`. */
  readonly name: string;
  readonly node: IconNode;
}

const TAGS: Readonly<Record<string, readonly string[]>> = tags;
const NODES = nodes as unknown as Readonly<Record<string, IconNode>>;

/** Every icon, by name. */
export const ICONS: readonly IconEntry[] = Object.keys(NODES)
  .sort()
  .map((name) => ({ name, keywords: TAGS[name] ?? [], node: NODES[name]! }));
