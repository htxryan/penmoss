/** A ledger event's fields as the view reads them, and its times as the page shows them. */

export const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);

export const num = (v: unknown) => (typeof v === 'number' ? v : null);

export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
