/**
 * A sample's label in the fonts panel (A1582): its role, the family its text asks for first and
 * its size in px, as drawn: "Text · Inter · 16 px". A generic family reads as a word ("System",
 * "Monospace"), a quoted one without its quotes.
 */

const GENERIC: Readonly<Record<string, string>> = {
  'system-ui': 'System',
  '-apple-system': 'System',
  blinkmacsystemfont: 'System',
  'ui-sans-serif': 'System',
  'sans-serif': 'Sans Serif',
  serif: 'Serif',
  'ui-serif': 'System Serif',
  monospace: 'Monospace',
  'ui-monospace': 'System Monospace',
  cursive: 'Cursive',
};

/** The first family in a computed `font-family`, as a person names it. */
export function firstFamily(stack: string): string {
  const first = (stack.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
  if (first === '') return 'System';
  return GENERIC[first.toLowerCase()] ?? first;
}

/** A computed `font-size` in px, to a tenth: "16 px", "13.5 px". */
export function pixels(size: string): string {
  const value = Number.parseFloat(size);
  if (!Number.isFinite(value)) return size;
  const rounded = Math.round(value * 10) / 10;
  return `${String(rounded)} px`;
}

export function fontLabel(role: string, family: string, size: string): string {
  return `${role} · ${firstFamily(family)} · ${pixels(size)}`;
}
