import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import { Icon } from '@penmoss/ui/icons';
import { useCommands, useKeys } from '../commands/hooks';
import { withKeys } from '../shell/drawer';
import { macWindowStore, useMacWindowState } from './mac-window';

/**
 * Keep on top's pin (T46, D38, A720): in the main window's sidebar header and a note window's
 * top bar, highlighted while this window floats above other apps. Only in the Mac app; it runs
 * `window.keepOnTop`, as View → Keep on top and the palette do, so all three stay in step.
 */
export function KeepOnTopButton() {
  const commands = useCommands();
  const keys = useKeys('window.keepOnTop');
  const { keepOnTop } = useMacWindowState();
  if (!macWindowStore()) return null;
  const tip = keepOnTop ? 'Kept on top of other apps: click to stop' : 'Keep on Top of Other Apps';
  return (
    <button
      type="button"
      className="icon-btn keep-on-top"
      data-command="window.keepOnTop"
      aria-label="Keep on Top"
      aria-pressed={keepOnTop}
      aria-keyshortcuts={ariaKeyShortcuts(keys) || undefined}
      data-tip={withKeys(tip, keys)}
      data-testid="keep-on-top"
      onClick={() => commands.run('window.keepOnTop')}
    >
      <Icon name="pin" size={18} />
    </button>
  );
}
