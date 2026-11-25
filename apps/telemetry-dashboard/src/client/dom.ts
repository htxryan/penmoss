/**
 * Building the page's elements, shared by the views and timeline.ts (PEN-173), so the dashboard
 * makes its elements one way.
 */

/** An element of `tag` with `className` (when there is one) holding `children`, in order. */
export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (className) made.className = className;
  made.append(...children);
  return made;
}

/**
 * A catalogue id that may wrap only after a '.' or a ':' (setting:privacy.limits.events.days),
 * never inside a word: its text with a <wbr> after each.
 */
export function breakableId(id: string): (Node | string)[] {
  const parts: (Node | string)[] = [];
  for (const piece of id.split(/(?<=[.:])/)) {
    if (parts.length > 0) parts.push(document.createElement('wbr'));
    parts.push(piece);
  }
  return parts;
}
