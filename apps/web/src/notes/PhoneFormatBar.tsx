import { Icon } from '@penmoss/ui/icons';
import type { PointerEvent } from 'react';
import { useCommands } from '../commands/hooks';
import { PHONE_FORMAT_BUTTONS } from './phone-format-buttons';

// Keeps the caret (and the on-screen keyboard) in the note while a button is pressed.
const keepFocus = (event: PointerEvent) => event.preventDefault();

/**
 * The phone's formatting bar (T36, after the prototype): fixed to the bottom
 * of the screen, which the on-screen keyboard shrinks
 * (`interactive-widget=resizes-content`), so it sits just above the keys.
 * Each button runs the editor command the shortcuts and the palette run, and
 * is named by that command's title.
 */
export function PhoneFormatBar() {
  const commands = useCommands();
  return (
    <div className="phone-format" role="toolbar" aria-label="Formatting">
      {PHONE_FORMAT_BUTTONS.map(({ command, icon }) => {
        const title = commands.definitions.get(command)?.title ?? command;
        return (
          <button
            key={command}
            type="button"
            className="icon-btn"
            data-command={command}
            aria-label={title}
            data-tip={title}
            onPointerDown={keepFocus}
            onClick={() => commands.run(command, { source: 'button' })}
          >
            <Icon name={icon} size={20} />
          </button>
        );
      })}
    </div>
  );
}
