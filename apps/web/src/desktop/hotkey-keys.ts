/**
 * The capture hotkey (A226) between the page's combinations (`Mod+Alt+N`, @penmoss/editor/keys)
 * and Electron's accelerators (`Command+Alt+N`), so it is recorded and shown like any shortcut.
 */
import { isApplePlatform, parseCombo } from '@penmoss/editor/keys';

/** Electron's name for each part of a combination (`Mod+Alt+N` → `Command+Alt+N` on a Mac). */
export function comboToAccelerator(combo: string, apple: boolean = isApplePlatform()): string {
  const { modifiers, key } = parseCombo(combo);
  const names = modifiers.map((modifier) =>
    modifier === 'Mod'
      ? apple
        ? 'Command'
        : 'Control'
      : modifier === 'Ctrl'
        ? 'Control'
        : modifier,
  );
  // Meta off a Mac is the Windows or Super key: parseCombo drops it, and so does a hotkey.
  const KEY_NAMES: Record<string, string> = { Enter: 'Return', '+': 'Plus' };
  return [...names, KEY_NAMES[key] ?? key].join('+');
}

/** A stored accelerator (`Control+Alt+Command+N`) as a combination, to show as keycaps. */
export function acceleratorToCombo(
  accelerator: string,
  apple: boolean = isApplePlatform(),
): string {
  const parts = accelerator.split(/\+(?!$)/);
  const key = parts.pop() ?? '';
  const modifiers = new Set<string>(
    parts.map((part) => {
      const name = part.toLowerCase();
      if (name === 'control' || name === 'ctrl') return apple ? 'Ctrl' : 'Mod';
      if (name === 'alt' || name === 'option') return 'Alt';
      if (name === 'shift') return 'Shift';
      return 'Mod'; // Command, CommandOrControl, Super: the platform's command key
    }),
  );
  const KEY_NAMES: Record<string, string> = { Return: 'Enter', Plus: '+' };
  const order = ['Mod', 'Ctrl', 'Alt', 'Shift'];
  return [...order.filter((name) => modifiers.has(name)), KEY_NAMES[key] ?? key].join('+');
}
