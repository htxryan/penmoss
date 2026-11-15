/**
 * Lucide's icons for what a person chooses (A1568): a notebook's badge, today. The app's own
 * chrome keeps its own set (`@penmoss/ui/icons`, A180). An icon is stored by name,
 * `lucide:notebook-pen`, and drawn from its own small chunk, so neither the page's first load nor
 * a badge needs the whole set; the picker loads the set (`lucide-catalog.ts`) when it opens.
 * Lucide is ISC licensed (public/third-party-notices.txt).
 */
import { createElement, useEffect, useState, type CSSProperties, type ReactNode } from 'react';

/** How a Lucide icon is stored: `lucide:` and its name. */
export const LUCIDE_PREFIX = 'lucide:';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The icon's name in a stored value (`lucide:star` is `star`), or null when it is not one. */
export function lucideName(value: string): string | null {
  if (!value.startsWith(LUCIDE_PREFIX)) return null;
  const name = value.slice(LUCIDE_PREFIX.length);
  return name.length <= 64 && NAME.test(name) ? name : null;
}

/** An icon's shapes as Lucide gives them: `[element, attributes]`. */
export type IconNode = ReadonlyArray<readonly [string, Readonly<Record<string, string | number>>]>;

/** What a lookup found: the shapes, or null for a name this build does not know. */
const resolved = new Map<string, IconNode | null>();
const pending = new Map<string, Promise<IconNode | null>>();

/** The icon's shapes, from its own chunk; null when Lucide has no icon of that name. */
export function loadLucideIcon(name: string): Promise<IconNode | null> {
  const known = resolved.get(name);
  if (known !== undefined) return Promise.resolve(known);
  let loading = pending.get(name);
  if (!loading) {
    loading = import('./lucide-icons')
      .then((icons) => icons.iconNode(name))
      .then(
        (node) => {
          resolved.set(name, node);
          pending.delete(name);
          return node;
        },
        () => {
          // A chunk that failed to load is tried again next time; nothing is remembered.
          pending.delete(name);
          return null;
        },
      );
    pending.set(name, loading);
  }
  return loading;
}

/** Shapes the catalogue already holds, so the picker's choice draws at once wherever it shows. */
export function rememberLucideIcon(name: string, node: IconNode): void {
  resolved.set(name, node);
}

/**
 * The icon's shapes as they load: undefined while loading, null for a name Lucide does not have
 * (the caller shows something else, A1568: a badge its letter).
 */
export function useLucideIcon(name: string | null): IconNode | null | undefined {
  const [, redraw] = useState(0);
  const known = name === null ? null : resolved.get(name);
  useEffect(() => {
    if (name === null || resolved.has(name)) return;
    let live = true;
    void loadLucideIcon(name).then(() => {
      if (live) redraw((count) => count + 1);
    });
    return () => {
      live = false;
    };
  }, [name]);
  return known;
}

/** The SVG elements an icon may hold: Lucide's shapes, nothing that runs or links. */
const SHAPES = new Set(['path', 'circle', 'rect', 'line', 'ellipse', 'polyline', 'polygon']);

/** The shapes as React elements (Lucide's own `key` attribute is the element's key). */
function shapes(node: IconNode): ReactNode[] {
  return node
    .filter(([element]) => SHAPES.has(element))
    .map(([element, { key, ...attributes }], index) =>
      createElement(element, { key: String(key ?? index), ...attributes }),
    );
}

/** A Lucide icon on its 24-unit grid, in the current colour, decorative (`aria-hidden`). */
export function LucideSvg({
  node,
  size = 16,
  className,
  style,
  name,
}: {
  readonly node: IconNode;
  readonly size?: number;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** Its name, for tests and the inspector (`data-lucide`). */
  readonly name?: string;
}) {
  return createElement(
    'svg',
    {
      className,
      style,
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
      'data-lucide': name,
    },
    shapes(node),
  );
}
