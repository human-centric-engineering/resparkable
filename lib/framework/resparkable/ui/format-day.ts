/**
 * A day of the month for the group screens, such as "5 November".
 *
 * A fixed locale and an explicit zone, so the server's render and the browser's
 * agree (a hydration mismatch otherwise), and the day is the group's day: a
 * group's month starts at midnight on its own clock, not the reader's.
 */
export function formatDay(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone }).format(
      date
    );
  } catch {
    // An unknown zone name: the UTC day is better than nothing.
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    }).format(date);
  }
}
