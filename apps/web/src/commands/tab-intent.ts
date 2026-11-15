/** Where ⌘↩ (`background`) or ⇧⌘↩ (`foreground`) opens a note: a new tab (PEN-140, A1498). */
export type TabIntent = 'background' | 'foreground';

/** The new tab a key or click with ⌘ (Ctrl) asks for, if any. */
export function tabIntentOf(event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}): TabIntent | undefined {
  if (!event.metaKey && !event.ctrlKey) return undefined;
  return event.shiftKey ? 'foreground' : 'background';
}
