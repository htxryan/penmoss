import { useCallback } from 'react';
import { devicePref, useDevicePref, type DevicePref } from './device-pref';

const panels = new Map<string, DevicePref<boolean>>();

/** A panel's collapsed state on this device, under `key` ("1" while collapsed). */
function collapsedPref(key: string): DevicePref<boolean> {
  let pref = panels.get(key);
  if (!pref) {
    pref = devicePref(key, {
      parse: (stored) => stored === '1',
      serialise: (collapsed) => (collapsed ? '1' : null),
    });
    panels.set(key, pref);
  }
  return pref;
}

/**
 * A sidebar panel's collapsed state, remembered on this device (T51: the Tags panel, A934, and
 * Quick Access, A946), under `key` in `localStorage` ("1" while collapsed). Open by default.
 */
export function useStoredCollapse(key: string): readonly [boolean, () => void] {
  const pref = collapsedPref(key);
  const [collapsed, setCollapsed] = useDevicePref(pref);
  const toggle = useCallback(() => setCollapsed(!pref.read()), [pref, setCollapsed]);
  return [collapsed, toggle] as const;
}
