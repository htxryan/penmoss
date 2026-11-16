import { desktop } from '../desktop/bridge';

/** The device a setting kept here alone is kept on, as a sentence says it. */
export const thisDevice = (): string => (desktop() ? 'this Mac' : 'this device');

/** What the laptop mark says, on hover, on focus and to a screen reader (A1559). */
export function deviceOnlyTip(many = false): string {
  return many
    ? `Unlike other settings, these settings are kept only on ${thisDevice()} and aren’t synced through your primary notebook.`
    : `Unlike other settings, this setting is kept only on ${thisDevice()} and isn’t synced through your primary notebook.`;
}

/** The platform whose devices share a per-platform setting here (PEN-156, A1605), as a sentence says it. */
export const thesePlatforms = (): string => (desktop() ? 'your Macs' : 'your computers');

/**
 * What the monitor says on a setting kept for the Macs apart from the phones (PEN-156, A1605): on
 * hover, on focus and to a screen reader.
 */
export function platformTip(many = false): string {
  return many
    ? `These settings are kept for ${thesePlatforms()} only. Your Android phones keep their own.`
    : `This setting is kept for ${thesePlatforms()} only. Your Android phones keep their own.`;
}
