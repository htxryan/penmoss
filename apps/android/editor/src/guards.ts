/** A plain object (never null or an array): what each bridge message and its parts must be. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
