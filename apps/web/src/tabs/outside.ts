import { showPath } from '../router';
import { mainTabs } from './controller';
import { NEW_TAB_PATH } from './state';

/**
 * A page another window, the menu bar icon or a deep link asks this one to show (A1498): a new
 * tab for a note window's ⌘T, else the tab already showing it or a new one.
 */
export function openFromOutside(path: string): void {
  const tabs = mainTabs();
  if (tabs && path === NEW_TAB_PATH) {
    // A note window's ⌘T: the New Tab picker here, the main window brought forward (A1594).
    tabs.askNewTab();
    return;
  }
  showPath(path);
}
