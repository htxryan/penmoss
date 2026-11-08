import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import { Icon } from '@penmoss/ui/icons';
import { useCommands, useKeys } from '../commands/hooks';
import { withKeys } from '../shell/drawer';
import { NOTE_BAR_BUTTON_INFO, type NoteBarButton } from './note-bar';

/** Test ids the bar's first two buttons had before the setting (T42, T52), kept for them. */
const TEST_IDS: Partial<Record<NoteBarButton, string>> = {
  fullWidth: 'toggle-full-width',
  copyAgentReference: 'copy-agent-reference',
};

/** One of the note title bar's buttons (A1134): the same command as its ⋯ item. */
export function NoteBarButtonView({
  button,
  pressed,
  label,
}: {
  button: NoteBarButton;
  /** A toggle's state, for Full Width, Markdown Source and Quick Access. */
  pressed?: boolean | undefined;
  /** Its tip when it differs from its name (Full Width while full width). */
  label?: string | undefined;
}) {
  const info = NOTE_BAR_BUTTON_INFO[button];
  const commands = useCommands();
  const keys = useKeys(info.command);
  return (
    <button
      type="button"
      className={button === 'delete' ? 'icon-btn danger' : 'icon-btn'}
      aria-label={info.label}
      aria-pressed={pressed}
      aria-keyshortcuts={ariaKeyShortcuts(keys) || undefined}
      data-tip={withKeys(label ?? info.label, keys)}
      data-command={info.command}
      data-note-bar={button}
      // In the click: copying needs the user's gesture.
      onClick={() => commands.run(info.command)}
      data-testid={TEST_IDS[button] ?? `note-bar-${button}`}
    >
      <Icon name={info.icon} size={18} />
    </button>
  );
}
