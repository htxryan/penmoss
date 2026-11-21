/**
 * What the replay's frame (PEN-178) reads at build time, not in the browser: the app's own line
 * icons (@penmoss/ui's Icon, rendered to SVG) and the note rail's tabs (apps/web's PANEL_TABS,
 * whose module brings React with it). build.mjs runs this in Node and hands the result to
 * frame.ts; the frame's tests call it directly. React renders only here, so none of it ships.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ICON_NAMES, Icon } from '@penmoss/ui/icons';
import { PANEL_TABS } from '@penmoss/web/src/notes/panel-tabs';

export interface FrameData {
  /** Every icon's SVG at 16 px, by name. */
  readonly icons: Readonly<Record<string, string>>;
  /** The note rail's tabs in order, each with its label and icon. */
  readonly panelTabs: readonly {
    readonly tab: string;
    readonly label: string;
    readonly icon: string;
  }[];
}

export function frameData(): FrameData {
  return {
    icons: Object.fromEntries(
      ICON_NAMES.map((name) => [name, renderToStaticMarkup(createElement(Icon, { name }))]),
    ),
    panelTabs: PANEL_TABS.map(({ tab, label, icon }) => ({ tab, label, icon })),
  };
}
