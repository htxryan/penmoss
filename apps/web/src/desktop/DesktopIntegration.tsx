import { openLightboxNow, setNativeClipboard } from '@penmoss/editor';
import { useEffect } from 'react';
import {
  useCommand,
  useCommands,
  useCommandsAvailability,
  useCommandsVersion,
} from '../commands/hooks';
import { navigate, useLocation } from '../router';
import { useThemeState } from '../theme/hooks';
import { desktop } from './bridge';
import { macWindowStore, useMacWindowState } from './mac-window';
import { menuModel } from './menu';
import { QuickAccessMenuBar } from './QuickAccessMenuBar';

/**
 * The Mac app's side of the shell (T29), mounted in its main window: native
 * menus kept in step with the command registry and the user's bindings,
 * menu choices run as commands, deep links (`penmoss://note/<id>`) opened as
 * in-app paths, and the clipboard bridge for T15's copy commands (HTML,
 * plain text and markdown in one write).
 * The windows' background follows the theme on screen (T28, A249). Keep on top (T46, A720)
 * is a command here, and View → Keep on top is ticked for this window while it is on. The main
 * window tells the Mac app the Quick Access notes for its menu bar icon (T51, A945, A946).
 */
export function DesktopIntegration() {
  const bridge = desktop();
  const commands = useCommands();
  const version = useCommandsVersion();
  // The chosen theme, not a preview: the windows and the next launch follow what is saved.
  const { theme, mode } = useThemeState();
  const light = theme.light.bg;
  const dark = theme.dark.bg;

  // Bindings, handlers and the open note's editor change the version, a route and a
  // handler's own state change what can run: titles,
  // keys and whether each item can run now (A526). Sent once this commit's effects have run,
  // so every command's handler reads the new state.
  const location = useLocation();
  const availability = useCommandsAvailability();
  // This window's pin (T46): the menu's tick, the pin button and the command read one state.
  const macWindow = macWindowStore(bridge);
  const { keepOnTop } = useMacWindowState();
  useEffect(() => {
    if (!bridge) return;
    const timer = setTimeout(() =>
      bridge.menu.set(
        menuModel(commands.definitions.values(), (id) => commands.keysOf(id), {
          available: (id) => commands.available(id),
          checked: (id) => (id === 'window.keepOnTop' && macWindow ? keepOnTop : undefined),
          macWindow: macWindow !== null,
        }),
      ),
    );
    return () => clearTimeout(timer);
  }, [bridge, commands, version, availability, location, macWindow, keepOnTop]);

  useCommand(
    'window.keepOnTop',
    () => void macWindow?.setKeepOnTop(!macWindow.get().keepOnTop),
    () => macWindow !== null,
  );

  useEffect(() => {
    if (!bridge) return;
    const stop = bridge.menu.onCommand(({ id, accelerator }) => {
      const combo = commands.keysOf(id)[0];
      if (accelerator && combo) commands.dispatchMenuShortcut(combo, document.activeElement);
      else {
        // A menu chosen with the pointer is deliberate: the image lightbox, modal to the page,
        // gives way to it (T51 review, A948). A menu's keys wait while it is open.
        openLightboxNow()?.close();
        commands.run(id, { source: 'menu' });
      }
    });
    // Listening now: what main held while this window loaded runs or opens (T51, A945).
    void bridge.menu.takePending?.().then((held) => {
      if (typeof held === 'string') commands.run(held, { source: 'menu' });
      else if (held && typeof held.path === 'string') navigate(held.path);
    });
    return stop;
  }, [bridge, commands]);

  useEffect(() => bridge?.onOpenPath((path) => navigate(path)), [bridge]);

  // The windows behind the page take the theme's background (T28, A249).
  useEffect(() => bridge?.theme?.set({ light, dark, mode }), [bridge, light, dark, mode]);

  useEffect(() => {
    if (!bridge) return;
    setNativeClipboard((payload) => bridge.clipboard.write(payload));
    return () => setNativeClipboard(null);
  }, [bridge]);

  // The menu bar icon's Quick Access notes (T51, A945): sent from the main window only.
  return <QuickAccessMenuBar />;
}
