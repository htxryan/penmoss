/** How long Trash shows a note's days left for (T21). */
export const TRASH_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days left of something deleted at `deletedAt` and kept `days` days (a note's
 * `TRASH_DAYS`, a folder's `FOLDER_TRASH_DAYS`): `days` the day it was deleted, never more, even
 * when it was deleted after `now` was read or by a device whose clock runs ahead (B9), and never
 * less than 0.
 */
export function trashDaysLeft(deletedAt: number, now: number, days: number = TRASH_DAYS): number {
  const left = Math.ceil((deletedAt + days * DAY_MS - now) / DAY_MS);
  return Math.min(days, Math.max(0, left));
}
