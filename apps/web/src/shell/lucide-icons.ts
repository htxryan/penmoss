/**
 * One Lucide icon at a time (A1568), loaded by `lucide.ts`: Lucide's own map of names (its
 * aliases too, so an icon Lucide renames still resolves) to one chunk per icon. This module is a
 * chunk of its own, so the page's first load never holds the map.
 */
import { lucideDynamicIconImports } from '@lucide/icons/dynamic';
import type { IconNode } from './lucide';

const IMPORTS: Readonly<Record<string, () => Promise<{ default: { node: unknown } }>>> =
  lucideDynamicIconImports;

/** The icon's shapes, or null for a name Lucide does not have. */
export async function iconNode(name: string): Promise<IconNode | null> {
  if (!Object.hasOwn(IMPORTS, name)) return null;
  const icon = await IMPORTS[name]!();
  return icon.default.node as IconNode;
}
