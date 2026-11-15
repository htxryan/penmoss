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

/**
 * Reveal in Sidebar (PEN-140): the note's row in Notebooks, its folders opened, scrolled to and
 * focused; the sidebar shows first if it was a rail or a closed drawer.
 */
const REVEAL_NOTE = 'penmoss:reveal-note';

export function revealNote(id: string): void {
  revealNotebooks();
  window.dispatchEvent(new CustomEvent<string>(REVEAL_NOTE, { detail: id }));
}

/** Runs `listener` with the note's id whenever something asks for its row to show. */
export function useOnRevealNote(listener: (id: string) => void): void {
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => {
    const on = (event: Event) => {
      const id = (event as CustomEvent<unknown>).detail;
      if (typeof id === 'string') latest.current(id);
    };
    window.addEventListener(REVEAL_NOTE, on);
    return () => window.removeEventListener(REVEAL_NOTE, on);
  }, []);
}
