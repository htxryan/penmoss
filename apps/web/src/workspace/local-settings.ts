import { isLocalSetting } from '@penmoss/core/settings';

/**
 * The look and layout this device keeps alone (A1626): `localStorage`, shared by the app's windows
 * and never synced, so a theme picked on one Mac never reaches another through a notebook. A null
 * is "back to the default here", whatever the synced value is.
 */
export const LOCAL_SETTINGS_KEY = 'penmoss.localSettings';

type Values = Record<string, unknown>;

export class LocalSettings {
  private values: Values;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: Storage | null) {
    this.values = this.read();
  }

  /** `settings` with this device's own values over them: a value replaces, a null removes. */
  over(settings: Record<string, unknown>): Record<string, unknown> {
    for (const [key, value] of Object.entries(this.values)) {
      if (!isLocalSetting(key)) continue;
      if (value === null) delete settings[key];
      else settings[key] = value;
    }
    return settings;
  }

  /** Keeps one setting on this device (undefined: its default here). */
  set(key: string, value: unknown): void {
    this.values = { ...this.values, [key]: value === undefined ? null : value };
    try {
      this.storage?.setItem(LOCAL_SETTINGS_KEY, JSON.stringify(this.values));
    } catch {
      // Private mode or a full disk: the choice lasts this session only.
    }
    this.changed();
  }

  /** Another window changed them (a `storage` event). */
  reload(): void {
    this.values = this.read();
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private read(): Values {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(LOCAL_SETTINGS_KEY) ?? '{}');
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Values)
        : {};
    } catch {
      return {};
    }
  }
}

function pageStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** This device's one copy, followed across the app's windows. */
export const localSettings = new LocalSettings(pageStorage());

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === LOCAL_SETTINGS_KEY || event.key === null) localSettings.reload();
  });
}
