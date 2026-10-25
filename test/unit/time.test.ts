// Checked through Intl rather than against hard-coded instants: zone rules change (tzdata 2026b moved BC to
// permanent daylight time) and machines carry different tzdata, so a fixed offset is only true on one of them.

import { describe, expect, it } from 'vitest';
import { startInstant, zonedInstant } from '../../src/time.ts';

const ZONES = [
  'America/Vancouver',
  'America/Edmonton',
  'America/New_York',
  'Europe/London',
  'Australia/Sydney',
  'UTC',
];

/** What the zone's clocks show at an instant: "YYYY-MM-DD HH:MM". */
const shows = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);

const offsetMin = (at: number, timeZone: string) => {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(at))
    .find((p) => p.type === 'timeZoneName')!.value; // "GMT-07:00", or "GMT" for UTC
  const m = /([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
};

/** The first instant in a year when the zone's clocks jump forward, if they do. */
function springForward(year: number, timeZone: string): { before: number; after: number } | null {
  for (let at = Date.UTC(year, 0, 1); at < Date.UTC(year + 1, 0, 1); at += 3_600_000)
    if (offsetMin(at + 3_600_000, timeZone) > offsetMin(at, timeZone))
      return { before: at, after: at + 3_600_000 };
  return null;
}

describe('a wall-clock time in a zone', () => {
  it('is the instant the zone shows it, on any day of the year', () => {
    for (const zone of ZONES)
      for (const date of ['2030-01-15', '2030-03-02', '2030-07-02', '2030-11-03', '2030-12-31'])
        for (const time of ['00:30', '09:00', '23:59'])
          expect(shows(zonedInstant(date, time, zone), zone), `${zone} ${date} ${time}`).toBe(
            `${date} ${time}`,
          );
  });

  it('reads a time that a change skips on the later side', () => {
    let tried = 0;
    for (const zone of ZONES) {
      const change = springForward(2030, zone);
      if (!change) continue; // this tzdata gives the zone no change in 2030
      tried++;
      // Ten minutes into the hour that never happens, by the clocks just before the change.
      const skipped = new Date(change.before + offsetMin(change.before, zone) * 60_000 + 3_600_000 + 600_000);
      const wall = skipped.toISOString().slice(0, 16).split('T') as [string, string];
      const at = zonedInstant(wall[0], wall[1], zone);
      expect(at.getTime(), zone).toBeGreaterThanOrEqual(change.after);
      expect(at.getTime() - change.after, zone).toBeLessThan(3_600_000);
    }
    expect(tried).toBeGreaterThan(0);
  });
});

describe('when a world starts', () => {
  const zone = 'America/Edmonton';
  const now = zonedInstant('2030-03-02', '13:00', zone);

  it('takes a time alone as the next one', () => {
    expect(shows(startInstant('17:00', zone, now), zone)).toBe('2030-03-02 17:00');
    expect(shows(startInstant('09:00', zone, now), zone)).toBe('2030-03-03 09:00');
  });

  it('takes a date and time as given, and refuses one already past', () => {
    expect(shows(startInstant('2030-03-04 08:30', zone, now), zone)).toBe('2030-03-04 08:30');
    expect(() => startInstant('2030-03-01 09:00', zone, now)).toThrow(/before the world's now/);
    expect(() => startInstant('9am', zone, now)).toThrow(/HH:MM/);
  });
});
