/** The time zones Settings → Daily Notes offers (A77), with their offsets and names. */
import { DEFAULT_TIME_ZONE } from '@penmoss/core/periodic';

/** Every IANA zone this browser knows, or the default alone where it cannot list them. */
export function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intl.supportedValuesOf?.('timeZone') ?? [];
  return zones.includes(DEFAULT_TIME_ZONE) ? zones : [DEFAULT_TIME_ZONE, ...zones];
}

/** This device's own zone (the system's), or null where the browser cannot say. */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** A zone's offset from UTC now: `UTC−6`, `UTC+5:30`, `UTC` (a minus sign, not a hyphen). */
export function utcOffset(timeZone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((each) => each.type === 'timeZoneName')?.value;
    if (!part) return '';
    return part.replace(/^GMT/, 'UTC').replace('-', '−');
  } catch {
    return '';
  }
}

/** A zone as people read it: `America/Argentina/Rio_Gallegos` → `America/Argentina/Rio Gallegos`. */
export const zoneName = (timeZone: string) => timeZone.replace(/_/g, ' ');
