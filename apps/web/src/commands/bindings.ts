/**
 * Key bindings stored as the signed-in user's synced settings (T20, A17):
 * one flat key per command, `keys.<command id>`, so rebinding two commands
 * on two devices merges, and each device sees the other's change live over
 * the WorkspaceDoc's socket.
 */
import { BINDING_PREFIX, isApplePlatform, rawBindings, usableBindings } from '@penmoss/editor/keys';
import type { BindingStore } from './center';
import { COMMANDS } from './definitions';

export { BINDING_PREFIX };

/** What the store needs from the Workspace service. */
export interface SettingsSource {
  settings(): Record<string, unknown>;
  setSetting(key: string, value: unknown): void;
  subscribe(listener: () => void): () => void;
}

const DEFAULT_KEYS = new Map(COMMANDS.map((command) => [command.id, command.keys]));

/**
 * The bindings this device can use (A90). The rule lives in `@penmoss/editor/keys` since T40
 * P9 (A490), so the Android editor page applies the same one; re-exported here for the web.
 */
export { usableBindings };

/** The user's bindings from their settings, ignoring malformed and unusable values. */
export function bindingsFromSettings(
  settings: Record<string, unknown>,
  apple: boolean = isApplePlatform(),
): Record<string, readonly string[]> {
  return usableBindings(rawBindings(settings), (id) => DEFAULT_KEYS.get(id), apple);
}

export function settingsBindings(source: SettingsSource): BindingStore {
  return {
    read: () => bindingsFromSettings(source.settings()),
    write: (id, keys) => source.setSetting(`${BINDING_PREFIX}${id}`, keys ? [...keys] : undefined),
    subscribe: (listener) => source.subscribe(listener),
  };
}
