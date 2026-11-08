import { createContext, useContext, useSyncExternalStore } from 'react';
import { ThemeController, type ThemeState } from './controller';

export const ThemeContext = createContext<ThemeController | null>(null);

/** Without a provider (server rendering, tests): Penmoss, applied to nothing. */
let detached: ThemeController | null = null;
function detachedController(): ThemeController {
  detached ??= new ThemeController({
    root: {
      style: { colorScheme: '', setProperty: () => undefined },
      setAttribute: () => undefined,
    },
    storage: null,
    systemDark: { matches: false, subscribe: () => () => undefined },
  });
  return detached;
}

export function useThemeController(): ThemeController {
  return useContext(ThemeContext) ?? detachedController();
}

export function useThemeState(): ThemeState {
  const controller = useThemeController();
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}
