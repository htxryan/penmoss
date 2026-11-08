/** The graph's address: global, or around a note (T17). */
export function graphPath(note: string | null, local = false): string {
  if (note === null) return '/graph';
  const params = new URLSearchParams({ note });
  if (local) params.set('local', '1');
  return `/graph?${params.toString()}`;
}
