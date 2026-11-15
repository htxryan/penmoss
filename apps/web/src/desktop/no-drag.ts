/**
 * What must never be part of a compact window's drag region (T47, A723, A727). On a Mac a drag
 * region wins over anything painted on top of it unless that thing is `no-drag`, so every
 * control anywhere in the page, and every surface that can float over a title-bar row (a
 * panel, a menu, a dialog, a scrim), is `no-drag` while `data-titlebar="compact"` is set.
 * `desktop/titlebar.css` holds the same lists (a unit test checks them) and the Electron suite checks
 * every visible element against them, and, without them, everything in a drag region that takes
 * a click. A surface before a row in the DOM stops the row dragging while it is open
 * (desktop/titlebar.css). No imports: the desktop suite reads it too.
 */

/** Controls: whatever takes a click or a key. */
export const NO_DRAG_CONTROLS = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'label',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="treeitem"]',
] as const;

/** Surfaces that can float over a title-bar row. */
export const NO_DRAG_SURFACES = [
  '.menu',
  '.menu-scrim',
  '.overlay',
  '.drawer-scrim',
  '.sidebar',
  '.settings-nav',
  '.toast',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  // The editor's own (A1123): the selection and table toolbars, and the slash and link menus,
  // over a note's top bar when the text they are for is scrolled up to it.
  '[role="toolbar"]',
  '.pm-slash-menu',
] as const;

/**
 * What scrolls under a row (A1123): a note's title and text go up under its top bar, which stays
 * put, Settings' sections under its bar, and the first run's screen under its strip (Ryan's review
 * of #192, finding 1) (PEN-65: Electron counts a control scrolled out of its
 * box as where it would be, so the bar stopped dragging once Settings scrolled). Electron applies later regions over earlier ones, so its controls' `no-drag` (later in the
 * DOM than the bar) took the bar's empty part from it as soon as the note scrolled, and the
 * window could not be moved by it. Their controls set no region of their own (`unset`: the
 * parent's): none of them is ever in a row. The floating surfaces among them (a menu, the
 * selection toolbar) stay `no-drag`, and so do the controls in them, from them.
 */
export const UNDER_ROWS = [
  '.note-columns',
  '.settings-content',
  '.window-bare',
  // The Tags page's tables, under its top (R2-4, R2-8 of Ryan's review of #193).
  '.tags-page-scroll',
] as const;

/**
 * The title-bar rows: they drag the window (A722, A723, A727). Version History's own head, a row
 * over its overlay, went with the overlay (T51, A936): it is a tab of the note's side panel. With
 * them, what drags where there is no row (Ryan's review of #192): the strip across the top of a
 * window with none of the app in it yet (the wait, the first run; finding 1), with no note open
 * the empty home beside the sidebar (finding 6), the Tags page's top, its title and filter (R2-8
 * of Ryan's review of #193), and the drawing editor's bar (R2-17).
 */
export const TITLE_BAR_ROWS = [
  '.sb-head',
  '.note-top',
  // The main window's tab strip (PEN-140, A1502): its first row beside the sidebar.
  '.tab-strip',
  '.pm-graph-bar',
  '.settings-bar',
  '.app-bar',
  '#root > .banner',
  '.window-drag',
  '.home',
  '.tags-page-top',
  '.drawing-editor-bar',
  // View This Version's head (A1572): its modal covers the rows beside the History panel, so its
  // head is the first row there; its buttons click.
  '.history-view-head',
] as const;

/**
 * Pictures of the app (A1564): a Settings preview, small or enlarged, draws the app's real rows,
 * which would drag the window from inside the page. In them no row drags (Ryan's review of #210).
 */
export const PICTURES = ['.preview-zoom', '.preview-zoom-body'] as const;
