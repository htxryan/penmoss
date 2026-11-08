import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { CommandCenter, RunContext } from './center';

export const CommandsContext = createContext<CommandCenter | null>(null);

export function useCommands(): CommandCenter {
  const commands = useContext(CommandsContext);
  if (!commands) throw new Error('useCommands outside CommandsProvider');
  return commands;
}

/** Re-renders when bindings, handlers or the open editor change. */
export function useCommandsVersion(): number {
  const commands = useCommands();
  return useSyncExternalStore(commands.subscribe, commands.getVersion, commands.getVersion);
}

/** Re-renders when a registered handler's `enabled` answer changes (A526). */
export function useCommandsAvailability(): number {
  const commands = useCommands();
  return useSyncExternalStore(
    commands.subscribeAvailability,
    commands.getAvailability,
    commands.getAvailability,
  );
}

/** The combinations bound to a command now (re-renders when they change). */
export function useKeys(id: string): readonly string[] {
  const commands = useCommands();
  useCommandsVersion();
  return commands.keysOf(id);
}

/**
 * Registers what runs `id` while the component is mounted. The latest
 * `run` and `enabled` are used, so they need not be stable.
 */
export function useCommand(
  id: string,
  run: (context: RunContext) => boolean | void,
  enabled?: () => boolean,
  /** When it cannot run, an earlier registration answers (A862: several folder trees). */
  options: { readonly yields?: boolean } = {},
): void {
  const yields = options.yields === true;
  const commands = useCommands();
  const latest = useRef({ run, enabled });
  /** What `enabled` answered after the last render (undefined before the first). */
  const was = useRef<boolean | undefined>(undefined);
  // In the commit, not after it (T39 pass 2): a menu choice or a key can arrive between a
  // render's commit and its passive effects, and must find this render's handler, not the
  // one before (which, on Devices, still saw a finished request as under way). A change in
  // what `enabled` answers is reported, so the Mac menus grey or ungrey the item (A526).
  useLayoutEffect(() => {
    latest.current = { run, enabled };
    const now = enabled?.() ?? true;
    if (was.current !== undefined && was.current !== now) commands.availabilityChanged();
    was.current = now;
  });
  // Registered in the commit too: a menu choice just after leaving a screen finds no
  // handler from it.
  useLayoutEffect(
    () =>
      commands.register(id, {
        run: (context) => latest.current.run(context),
        enabled: () => latest.current.enabled?.() ?? true,
        ...(yields ? { yields: true } : {}),
      }),
    [commands, id, yields],
  );
}
