/** Whether this is an Apple platform (⌘ for Mod, and key labels as symbols). */
export function isApple(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
}
