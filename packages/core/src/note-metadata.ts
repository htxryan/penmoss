/**
 * Pinned metadata (T62 item 4): which of a note's details show under its title, and which in the
 * status bar along the bottom of the note. Synced per-user settings, as the sidebar's layout is,
 * so the choice follows the person to every device:
 *
 * - `metadata.underTitle`: the fields shown under the title (none unset). Any field, Tags with
 *   its + included.
 * - `metadata.statusBar`: the fields in the status bar (Words, Characters and Reading Time
 *   unset). Read-only fields only: Tags are edited, so never there.
 *
 * Each list is stored in the fields' own order (`METADATA_FIELDS`), so a field turned on takes
 * its place rather than going last. Ids this build does not know are skipped.
 */

/** The fields, in the order they show wherever they are pinned. */
export const METADATA_FIELDS = [
  'notebook',
  'folder',
  'created',
  'edited',
  'tags',
  'words',
  'characters',
  'reading',
  'tokens',
] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];

/** Each field's name, as the Metadata tab and Settings say it. */
export const METADATA_FIELD_NAMES: Readonly<Record<MetadataField, string>> = {
  notebook: 'Notebook',
  folder: 'Folder',
  created: 'Created',
  edited: 'Edited',
  tags: 'Tags',
  words: 'Words',
  characters: 'Characters',
  reading: 'Reading Time',
  tokens: 'Token Count',
};

/** The fields the status bar may show: every field but Tags, which is edited. */
export const STATUS_BAR_FIELDS: readonly MetadataField[] = METADATA_FIELDS.filter(
  (field) => field !== 'tags',
);

export const UNDER_TITLE_SETTING = 'metadata.underTitle';
export const STATUS_BAR_SETTING = 'metadata.statusBar';

/** Every pinned-metadata setting. */
export const NOTE_METADATA_KEYS = [UNDER_TITLE_SETTING, STATUS_BAR_SETTING] as const;

/** The status bar unset: the counts it has always shown. */
export const STATUS_BAR_DEFAULT: readonly MetadataField[] = ['words', 'characters', 'reading'];

/** Why `value` cannot be stored as the metadata setting `key`, or null when it can. */
export function noteMetadataProblem(key: string, value: unknown): string | null {
  if (value === null) return null;
  if (key !== UNDER_TITLE_SETTING && key !== STATUS_BAR_SETTING)
    return `${key} is not a metadata setting`;
  if (!Array.isArray(value) || value.length > 20) return `${key} must be a list of fields`;
  const seen = new Set<string>();
  for (const id of value as unknown[]) {
    if (typeof id !== 'string' || !/^[A-Za-z]{1,40}$/.test(id)) return `${key} must hold field ids`;
    if (seen.has(id)) return `${key} repeats ${id}`;
    if (key === STATUS_BAR_SETTING && id === 'tags') return `${key} cannot hold tags`;
    seen.add(id);
  }
  return null;
}

function fieldsOf(
  settings: Readonly<Record<string, unknown>>,
  key: string,
  fallback: readonly MetadataField[],
  allowed: readonly MetadataField[],
): readonly MetadataField[] {
  const value = settings[key];
  if (!Array.isArray(value) || noteMetadataProblem(key, value) !== null) return fallback;
  return allowed.filter((field) => (value as unknown[]).includes(field));
}

/** The fields shown under a note's title, in order. */
export function underTitleFieldsOf(
  settings: Readonly<Record<string, unknown>>,
): readonly MetadataField[] {
  return fieldsOf(settings, UNDER_TITLE_SETTING, [], METADATA_FIELDS);
}

/** The fields in the status bar, in order. */
export function statusBarFieldsOf(
  settings: Readonly<Record<string, unknown>>,
): readonly MetadataField[] {
  return fieldsOf(settings, STATUS_BAR_SETTING, STATUS_BAR_DEFAULT, STATUS_BAR_FIELDS);
}

/** `fields` with `field` turned on or off, in the fields' own order (a stable value). */
export function withField(
  fields: readonly MetadataField[],
  field: MetadataField,
  on: boolean,
): readonly MetadataField[] {
  return METADATA_FIELDS.filter((each) => (each === field ? on : fields.includes(each)));
}
