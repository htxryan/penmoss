import { useEffect, useRef } from 'react';

/**
 * New Folder and New Notebook name the new folder in the tree, so they show Notebooks first:
 * open if it was collapsed, back in the sidebar if it was hidden (T53 item 8, A983).
 */
const REVEAL_NOTEBOOKS = 'penmoss:reveal-notebooks';

export function revealNotebooks(): void {
  window.dispatchEvent(new Event(REVEAL_NOTEBOOKS));
}

/** Runs `listener` whenever something asks for Notebooks to show. */
export function useOnRevealNotebooks(listener: () => void): void {
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => {
    const on = () => latest.current();
    window.addEventListener(REVEAL_NOTEBOOKS, on);
    return () => window.removeEventListener(REVEAL_NOTEBOOKS, on);
  }, []);
}
