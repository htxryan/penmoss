/**
 * One way to show a moment in lists (T39): "Oct 24, 5:53 AM", with the year
 * only when it is not this year. Settings → Devices, Status and Git mirror
 * showed the browser's full numeric date and seconds ("10/24/2026, 5:52:08 AM"),
 * unlike the rest of the app.
 */
export function shortWhen(time: number | null, now: number = Date.now()): string {
  if (!time) return 'never';
  const date = new Date(time);
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}
