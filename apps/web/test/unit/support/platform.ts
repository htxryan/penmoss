import { afterEach } from 'vitest';
/**
 * The unit tests describe a keyboard without ⌘, where Ctrl is Mod, unless a test stubs another
 * platform itself (commandsOn in commands.test.ts). Node's `navigator.platform` is the host's,
 * so pin it: on a Mac (the CI runners, A404) the tests then check exactly what they check on
 * Linux. Defined on the object, so a test's vi.unstubAllGlobals() keeps it.
 */
Object.defineProperty(globalThis.navigator, 'platform', {
  value: 'Linux x86_64',
  configurable: true,
});

/**
 * This device's own look and layout (A1626) is one copy for the app, kept in `localStorage`: each
 * test starts without the last one's.
 */
afterEach(async () => {
  const { LOCAL_SETTINGS_KEY, localSettings } =
    await import('../../../src/workspace/local-settings');
  try {
    globalThis.localStorage?.removeItem(LOCAL_SETTINGS_KEY);
  } catch {
    // No storage in this environment: the copy is in memory alone.
  }
  localSettings.reload();
});
