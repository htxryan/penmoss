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
