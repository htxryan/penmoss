/**
 * The collapsed sidebar (T41, A508): an icon rail with Search, Today, This
 * week, Graph and Commands, and no note list, calendar or tags. Remembered
 * on this device, like the Info panel: how much room the sidebar gets depends
 * on the window, not on the person. A phone has its drawer instead.
 */
import { devicePref, useDevicePref } from './device-pref';

const SIDEBAR_KEY = 'penmoss.sidebar';

const collapsed = devicePref(SIDEBAR_KEY, {
  parse: (stored) => stored === 'collapsed',
  serialise: (on) => (on ? 'collapsed' : null),
});

export function useSidebarCollapsed(): readonly [boolean, (collapsed: boolean) => void] {
  return useDevicePref(collapsed);
}
