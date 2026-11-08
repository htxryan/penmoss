/**
 * Who moved a note to Trash (T42, A574), as `GET /api/trash` names it (#113): an agent (shown
 * with ✦, as in History) or a device. A server from before T42, or anything malformed, names
 * no one.
 */
export interface DeletedBy {
  readonly label: string;
  readonly kind: 'agent' | 'device';
}

export function parseDeletedBy(value: unknown): DeletedBy | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { label, kind } = value as { label?: unknown; kind?: unknown };
  if (typeof label !== 'string' || !label.trim()) return undefined;
  if (kind !== 'agent' && kind !== 'device') return undefined;
  return { label: label.trim(), kind };
}

/**
 * A deleter's name without ✦, which marks agents only: a device or token named "Claude ✦"
 * must not pass for an agent (review N8). The chip draws the mark itself, for agents.
 */
export function plainLabel(label: string): string {
  return (
    label
      .replace(/\u2726/gu, '')
      .replace(/\s+/gu, ' ')
      .trim() || label
  );
}
