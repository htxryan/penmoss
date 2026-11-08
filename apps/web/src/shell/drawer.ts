import { formatCombo } from '@penmoss/editor/keys';
import { createContext } from 'react';

/** The phone's navigation drawer (the sidebar), as the app bar's menu button sees it. */
export interface DrawerControl {
  readonly open: boolean;
  /** The drawer's element id. */
  readonly id: string;
  readonly show: () => void;
}

export const DrawerContext = createContext<DrawerControl | null>(null);

/** "Label (⌘K)" for a tooltip: the first combination bound, if any. */
export function withKeys(label: string, keys: readonly string[]): string {
  return keys[0] ? `${label} (${formatCombo(keys[0])})` : label;
}
