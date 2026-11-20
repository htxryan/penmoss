/**
 * What a setting's change records (PEN-137, PEN-175): its value when that is safe to send, else
 * `changed: true`. Shared by the page (`apps/web/src/analytics/track.ts`, which first turns a
 * custom theme or font into `custom`) and the Mac's main process, which records the settings it
 * writes itself (`apps/desktop/src/setting-events.ts`).
 */
import { isSettingWord } from './catalogue';
import { countBucket, type PropValue } from './events';

/**
 * A boolean or a whole number as itself, a number with a fraction as a count bucket, and text
 * only when it is one of the words core lists for that setting (SETTING_VALUES); any other text
 * (a time zone, a template, a font's family, a hotkey) records `changed: true`.
 */
export function settingValueProps(name: string, value: unknown): Record<string, PropValue> {
  if (typeof value === 'boolean') return { value };
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value <= 10_000_000) return { value };
    if (Number.isFinite(value) && value >= 0) return { value: countBucket(value) };
    return { changed: true };
  }
  if (typeof value === 'string' && isSettingWord(name, value)) return { value };
  return { changed: true };
}
