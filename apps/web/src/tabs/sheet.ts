/** Whether the narrow window's tab sheet is open (PEN-140, AC13): one for the window. */
let open = false;
const listeners = new Set<() => void>();

export const sheet = {
  get: (): boolean => open,
  set: (next: boolean): void => {
    if (next === open) return;
    open = next;
    for (const listener of [...listeners]) listener();
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
