/**
 * The two tabs of Settings → Appearance, Sidebar and Note (A1633): data with no React, so the
 * usage dashboard's Playback (PEN-178) draws the same tabs from this one source. PreviewTabs.tsx
 * renders them.
 */
import type { IconName } from '@penmoss/ui/icons';

export type PreviewTab = 'settings' | 'preview';

export const PREVIEW_TABS: ReadonlyArray<{
  readonly tab: PreviewTab;
  readonly label: string;
  readonly icon: IconName;
}> = [
  { tab: 'settings', label: 'Settings', icon: 'settings' },
  { tab: 'preview', label: 'Preview', icon: 'eye' },
];
