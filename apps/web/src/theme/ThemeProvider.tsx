import { useEffect, type ReactNode } from 'react';
import { useWorkspace } from '../workspace/hooks';
import type { ThemeController } from './controller';
import { ThemeContext } from './hooks';

/**
 * Feeds the Journal notebook's settings to the theme controller (T28, A827) once its workspace
 * has been read; until then the theme this device last showed stays.
 */
export function ThemeProvider({
  controller,
  children,
}: {
  controller: ThemeController;
  children: ReactNode;
}) {
  const workspace = useWorkspace();
  useEffect(() => {
    const sync = () => {
      controller.setSettings(workspace.getState().loaded ? workspace.settings() : null);
    };
    sync();
    return workspace.subscribe(sync);
  }, [controller, workspace]);
  return <ThemeContext.Provider value={controller}>{children}</ThemeContext.Provider>;
}
