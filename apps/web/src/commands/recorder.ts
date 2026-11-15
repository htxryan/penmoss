/**
 * Recording a key combination (T20; PEN-146): while `active`, every key press goes to `onKey`
 * as a combination (`Mod+Shift+L`; a lone modifier is not one, so it keeps listening) before
 * anything else sees it, and the command dispatcher stands aside. `onKey` answers false to let
 * the key through as it was (typing in Keyboard Shortcuts' search field); otherwise the key goes
 * no further, not to the page, the note or the Mac app's menus.
 *
 * Keyboard Shortcuts records a command's keys with it, searches by keys with it, and Quick
 * Capture records the Mac app's capture hotkey with it, so every shortcut is set the same way.
 */
import { bindingProblem, comboFromEvent, isApplePlatform, parseCombo } from '@penmoss/editor/keys';
import { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { CommandsContext } from './hooks';

export function useKeyRecorder(
  active: boolean,
  onKey: (combo: string, event: KeyboardEvent) => boolean | void,
): void {
  // Outside the app's commands (a test of one page) there is no dispatcher to stand aside.
  const commands = useContext(CommandsContext);
  const latest = useRef(onKey);
  useLayoutEffect(() => {
    latest.current = onKey;
  });
  useEffect(() => {
    if (!active) return;
    const resume = commands?.suspend();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const combo = comboFromEvent(event);
      if (!combo) return;
      if (latest.current(combo, event) === false) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      resume?.();
    };
  }, [active, commands]);
}

/** Keys that move the caret or delete in the search field: they keep doing that there. */
const FIELD_KEYS = new Set(['Left', 'Right', 'Up', 'Down', 'Home', 'End', 'Backspace', 'Delete']);

/**
 * Whether a key pressed in the search field looks for a shortcut: a combination a command could
 * have (A90), not typing, the clipboard and editing keys, or moving in the field.
 */
export function searchesByKeys(combo: string, apple: boolean = isApplePlatform()): boolean {
  if (bindingProblem(combo, apple) !== null) return false;
  return !FIELD_KEYS.has(parseCombo(combo).key);
}
