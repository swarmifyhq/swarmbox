import { describe, expect, it } from 'vitest';
import { startInstant, zonedInstant } from '../../src/time.ts';

describe('a wall-clock time in a zone', () => {
  it('is the instant the zone shows it, either side of a daylight change', () => {
    // Edmonton: 07:00 behind UTC in winter, 06:00 in summer (the 2030 change is 10 March).
    expect(zonedInstant('2030-03-02', '09:00', 'America/Edmonton').toISOString()).toBe(
      '2030-03-02T16:00:00.000Z',
    );
    expect(zonedInstant('2030-07-02', '09:00', 'America/Edmonton').toISOString()).toBe(
      '2030-07-02T15:00:00.000Z',
    );
    expect(zonedInstant('2030-03-11', '00:30', 'America/Edmonton').toISOString()).toBe(
      '2030-03-11T06:30:00.000Z',
    );
    expect(zonedInstant('2030-03-02', '09:00', 'UTC').toISOString()).toBe('2030-03-02T09:00:00.000Z');
  });

  it('reads a time that the change skips on the later side', () => {
    // 02:30 on 10 March 2030 never happens in Edmonton: clocks go from 02:00 to 03:00.
    expect(zonedInstant('2030-03-10', '02:30', 'America/Edmonton').toISOString()).toBe(
      '2030-03-10T09:30:00.000Z',
    );
  });
});

describe('when a world starts', () => {
  const now = new Date('2030-03-02T20:00:00Z'); // 13:00 in Edmonton

  it('takes a time alone as the next one', () => {
    expect(startInstant('17:00', 'America/Edmonton', now).toISOString()).toBe('2030-03-03T00:00:00.000Z');
    expect(startInstant('09:00', 'America/Edmonton', now).toISOString()).toBe('2030-03-03T16:00:00.000Z');
  });

  it('takes a date and time as given, and refuses one already past', () => {
    expect(startInstant('2030-03-04 08:30', 'America/Edmonton', now).toISOString()).toBe(
      '2030-03-04T15:30:00.000Z',
    );
    expect(() => startInstant('2030-03-01 09:00', 'America/Edmonton', now)).toThrow(/before the world's now/);
    expect(() => startInstant('9am', 'America/Edmonton', now)).toThrow(/HH:MM/);
  });
});
