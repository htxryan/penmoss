import { desktop } from '../desktop/bridge';

/** The device a setting kept here alone is kept on, as a sentence says it. */
export const thisDevice = (): string => (desktop() ? 'this Mac' : 'this device');

/** What the laptop mark says, on hover, on focus and to a screen reader (A1559). */
export function deviceOnlyTip(many = false): string {
  return many
    ? `Unlike other settings, these settings are kept only on ${thisDevice()} and aren’t synced through your primary notebook.`
    : `Unlike other settings, this setting is kept only on ${thisDevice()} and isn’t synced through your primary notebook.`;
}
