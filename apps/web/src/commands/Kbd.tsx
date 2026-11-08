import { comboParts } from '@penmoss/editor/keys';

/** A key combination as keycaps (⌘ ⇧ E, or Ctrl Shift E). */
export function Kbd({ combo }: { combo: string | undefined }) {
  if (!combo) return null;
  return (
    <span className="keys">
      {comboParts(combo).map((part, index) => (
        <kbd key={index}>{part}</kbd>
      ))}
    </span>
  );
}
