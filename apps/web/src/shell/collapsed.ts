import { useCallback, useState } from 'react';

/**
 * A sidebar panel's collapsed state, remembered on this device (T51: the Tags panel, A934, and
 * Quick Access, A946), under `key` in `localStorage` ("1" while collapsed). Open by default.
 */
export function useStoredCollapse(key: string): readonly [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(key));
  const toggle = useCallback(() => {
    setCollapsed((was) => {
      writeCollapsed(key, !was);
      return !was;
    });
  }, [key]);
  return [collapsed, toggle] as const;
}

export function readCollapsed(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(key: string, collapsed: boolean): void {
  try {
    if (collapsed) globalThis.localStorage?.setItem(key, '1');
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // Remembering is a convenience: the panel still opens and closes.
  }
}
