// Wall-clock times in a tenant's own zone, for a scenario that says when its day starts ("09:00", or
// "2026-10-31 23:30" for a test across a time change). Intl does the zone arithmetic, with whatever tzdata this
// Node carries; no date library.

/** How far ahead of UTC the zone's clocks are at an instant, in ms. */
function offsetAt(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    +parts.year!,
    +parts.month! - 1,
    +parts.day!,
    +parts.hour!,
    +parts.minute!,
    +parts.second!,
  );
  return asUtc - (at - (at % 1000));
}

/** The zone's calendar date at an instant, YYYY-MM-DD. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** The instant a wall-clock time on a date is in a zone. A time a change skips is read on the later side. */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // The offset depends on the instant being found: try the offset at the wall time read as UTC, then the
  // offset at that guess. One of them shows the wall time, unless a change skips it; then the later one.
  const first = wall - offsetAt(wall, timeZone);
  const second = wall - offsetAt(first, timeZone);
  const shows = (at: number) => at + offsetAt(at, timeZone) === wall;
  return new Date(shows(first) ? first : shows(second) ? second : Math.max(first, second));
}

export const STARTS_AT = /^(?:(\d{4}-\d{2}-\d{2}) )?([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * When a world told to start at `startsAt` ("HH:MM", or "YYYY-MM-DD HH:MM", in the zone) should be, seen
 * from `now`. A time alone is the next one: today's if it is still ahead, else tomorrow's. A date and time
 * in the past is refused, since a world's clock only goes forward.
 */
export function startInstant(startsAt: string, timeZone: string, now: Date): Date {
  const m = STARTS_AT.exec(startsAt);
  if (!m) throw new Error(`startsAt ${JSON.stringify(startsAt)}: give "HH:MM" or "YYYY-MM-DD HH:MM"`);
  const time = `${m[2]}:${m[3]}`;
  if (m[1]) {
    const at = zonedInstant(m[1], time, timeZone);
    if (at.getTime() < now.getTime())
      throw new Error(`startsAt ${startsAt} (${timeZone}) is before the world's now, ${now.toISOString()}`);
    return at;
  }
  const today = zonedInstant(localDate(now, timeZone), time, timeZone);
  if (today.getTime() >= now.getTime()) return today;
  return zonedInstant(localDate(new Date(now.getTime() + 86_400_000), timeZone), time, timeZone);
}
