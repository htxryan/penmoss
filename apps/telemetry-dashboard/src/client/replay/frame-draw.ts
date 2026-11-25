/**
 * Draws a replay's Frame (PEN-178) as Penmoss looked: the app's own markup (the class names and
 * structure the running app renders: App.tsx, SidebarBody, TabStrip, NoteView, SettingsPage, the
 * pickers and dialogs) under the app's own stylesheets, loaded by player.html. The markup is
 * written here by hand, a stated exception to A1564 (the components need a notebook source and
 * an editor the dashboard hasn't got), and test/client/app-classes.test.ts fails when a class it
 * uses is no longer in the app. The lists it draws (Settings' pages, groups, rows and icons, the
 * sidebar's shortcuts, the phone's formatting bar, the note's bar) are the app's own, imported.
 *
 * Nothing a person wrote is drawn: notes, names and fields are lorem ipsum of recorded lengths.
 * Under the page's CSP (style-src 'self') no style attribute is written: a custom property goes
 * in data-pf-vars and is set through style.setProperty.
 *
 * Each surface is its own file in draw/: markup.ts (writing elements, and the pieces every surface
 * uses), sidebar.ts, bars.ts (the note's bar, the tab strip, the phone's app bar), note.ts,
 * screens.ts (the empty state and Settings) and dialogs.ts. This file puts them together.
 */
import { applyThemeTo } from '@penmoss/ui/theme';
import type { FrameData } from './frame-data';
import { NARROW_PX, isNoteScreen, type Frame } from './state';
import { h, vars, type Draw, themeOf } from './draw/markup';
import { sidebar } from './draw/sidebar';
import { tabStrip } from './draw/bars';
import { noteScreen } from './draw/note';
import { emptyScreen, settingsScreen } from './draw/screens';
import { dialogMarkup } from './draw/dialogs';

/** What the page posts the frame. */
export interface FrameMessage {
  readonly type: 'frame';
  readonly frame: Frame;
  /** Light or dark, System already resolved by the page. */
  readonly variant: 'light' | 'dark';
  /** Its number, which the frame sends back once it has drawn it. */
  readonly seq?: number;
}

// ---------------------------------------------------------------------------------------------
// The whole window.

/** The frame's markup: the window as the app drew it at that moment. */
export function frameMarkup(frame: Frame, data: FrameData): string {
  const draw: Draw = {
    frame,
    data,
    phone: frame.window.width <= NARROW_PX,
    mac: frame.client === 'mac',
  };
  const dialogs = frame.dialogs
    .map((dialog, i) =>
      h('div', { class: 'pf-layer', 'data-dialog': dialog.name }, dialogMarkup(draw, dialog, i)),
    )
    .join('');
  if (frame.screen?.startsWith('settings')) return settingsScreen(draw) + dialogs;
  const onNote = isNoteScreen(frame.screen);
  const rail = frame.layout.sidebar === 'rail' && !draw.phone;
  const strip = draw.mac && !draw.phone;
  const navInTitleBar = rail && (onNote || strip);
  const drawerOpen = draw.phone && frame.layout.sidebar === 'shown';
  const hidden = !draw.phone && frame.layout.sidebar === 'hidden';
  const screen = onNote ? noteScreen(draw, navInTitleBar, strip) : emptyScreen(draw);
  return (
    h(
      'div',
      {
        class: hidden ? 'notes-app pf-no-sidebar' : 'notes-app',
        'data-drawer': drawerOpen ? 'open' : undefined,
        'data-sidebar': rail ? 'collapsed' : undefined,
        'data-pf-vars': vars({
          '--pm-sidebar-width': `${(frame.layout.sidebarWidth ?? 272) / 16}rem`,
        }),
      },
      sidebar(draw, navInTitleBar),
      drawerOpen ? h('div', { class: 'drawer-scrim', 'aria-hidden': 'true' }) : '',
      h(
        'main',
        { class: 'note-main' },
        strip ? tabStrip(draw, navInTitleBar) : '',
        h('div', { class: 'tab-panel', id: 'tab-panel' }, screen),
      ),
    ) + dialogs
  );
}

/** Each scrolled area's element in the drawn frame. */
const AREAS: Readonly<Record<string, string>> = {
  note: '[data-pf-area="note"]',
  sidebar: '.sb-list',
  // The elements the app's useScrollArea watches (sidebar-layout.tsx, NotebooksSection.tsx).
  'sidebar.folders': '.sb-notebooks-body',
  'sidebar.recent': '.sb-part[data-section="recent"]',
  'sidebar.tags': '.sb-part[data-section="tags"]',
  settings: '[data-pf-area="settings"]',
  'settings.nav': '[data-pf-area="settings.nav"]',
};

let drawn = '';

/** Draws `message`'s frame into `doc`: its theme, its markup, its custom properties, its scroll. */
export function drawFrame(doc: Document, message: FrameMessage, data: FrameData): void {
  const { frame, variant } = message;
  applyThemeTo(doc.documentElement, themeOf(frame), variant);
  // Every Mac window has the compact title bar out of full screen (A722): the app's own
  // titlebar.css then leaves the traffic lights' room and hides the name in the sidebar's head.
  if (frame.client === 'mac' && !frame.window.fullScreen) {
    doc.documentElement.dataset['titlebar'] = 'compact';
  } else {
    delete doc.documentElement.dataset['titlebar'];
  }
  const markup = frameMarkup(frame, data);
  const root = doc.getElementById('root') ?? doc.body;
  if (markup !== drawn || root.dataset['pfDrawn'] !== '1') {
    root.innerHTML = markup;
    root.dataset['pfDrawn'] = '1';
    drawn = markup;
    for (const element of root.querySelectorAll<HTMLElement>('[data-pf-vars]')) {
      for (const pair of (element.dataset['pfVars'] ?? '').split(';')) {
        const at = pair.indexOf(':');
        if (at > 0) element.style.setProperty(pair.slice(0, at), pair.slice(at + 1));
      }
    }
  }
  const narrow = frame.window.width <= NARROW_PX;
  for (const [area, selector] of Object.entries(AREAS)) {
    // On a narrow window Settings scrolls the window's own page (SettingsPage, PEN-175).
    const element =
      area === 'settings' && narrow
        ? (doc.scrollingElement as HTMLElement | null)
        : root.querySelector<HTMLElement>(selector);
    if (!element) continue;
    const position = frame.scroll[area] ?? 0;
    element.scrollTop = position * Math.max(0, element.scrollHeight - element.clientHeight);
  }
}
