// node --test actions/auto-post/schedule.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './schedule.mjs';

// Fixture matching windows.json (America/New_York). All wall-clock times below
// are Eastern; the Date() args are UTC.
const CONFIG = {
  timezone: 'America/New_York',
  minRemainingMinutes: 35,
  maxDeferHours: 8,
  windows: [
    { day: 'tue', start: '11:00', end: '12:00' },
    { day: 'tue', start: '22:00', end: '23:00' },
    { day: 'wed', start: '10:00', end: '11:00' },
    { day: 'wed', start: '21:00', end: '22:00' },
    { day: 'thu', start: '00:00', end: '01:00' },
    { day: 'thu', start: '02:00', end: '03:00' },
    { day: 'thu', start: '12:00', end: '13:00' },
    { day: 'fri', start: '15:00', end: '16:00' },
    { day: 'sat', start: '08:00', end: '09:00' },
    { day: 'sat', start: '22:00', end: '23:00' },
  ],
};

// 2026-08-11 is a Tuesday. During DST (EDT = UTC-4).
// Tue 11:05 ET = Tue 15:05 UTC — inside Tue 11:00-12:00 window with 55 min left.
test('post-now: comfortably inside an active window', () => {
  const now = new Date('2026-08-11T15:05:00Z');
  const r = decide(now, CONFIG);
  assert.equal(r.action, 'post-now');
  assert.match(r.reason, /In active window/);
});

// Tue 11:30 ET → 30 min remaining, below 35 min threshold → defer.
// Next window is Tue 22:00 ET, ~10.5h away → still > maxDeferHours (8) →
// posts now with staleness warning.
test('in-window with too-little runway + next window past deadline → post-now with staleness', () => {
  const now = new Date('2026-08-11T15:30:00Z'); // Tue 11:30 ET
  const r = decide(now, CONFIG);
  assert.equal(r.action, 'post-now');
  assert.match(r.reason, /staleness/);
});

// Tue 21:45 ET → in Tue 22:00-23:00? No, 21:45 is before start. Not in window.
// Next window is Tue 22:00, 15 min away → defer.
test('defer: not in window, next window is soon', () => {
  const now = new Date('2026-08-12T01:45:00Z'); // Tue 21:45 ET
  const r = decide(now, CONFIG);
  assert.equal(r.action, 'defer');
  assert.ok(r.runAt);
  // Runs at Tue 22:02 ET = Wed 02:02 UTC
  assert.equal(new Date(r.runAt).toISOString(), '2026-08-12T02:02:00.000Z');
});

// Sun 12:00 ET — no windows Sunday. Next is Tue 11:00 ET, ~47h away →
// > maxDeferHours → post-now.
test('post-now: no window within maxDeferHours', () => {
  const now = new Date('2026-08-09T16:00:00Z'); // Sun 12:00 ET
  const r = decide(now, CONFIG);
  assert.equal(r.action, 'post-now');
  assert.match(r.reason, /staleness/);
});

// Fri 15:20 ET → in Fri 15-16 window with 40 min left → post-now.
test('post-now: mid-window with exactly-enough runway (edge)', () => {
  const now = new Date('2026-08-14T19:20:00Z'); // Fri 15:20 ET (EDT)
  const r = decide(now, CONFIG);
  assert.equal(r.action, 'post-now');
  assert.equal(r.window.day, 'fri');
});

// Fri 15:30 ET → 30 min left in the window (< 35). Next is Sat 08:00 ET,
// ~16.5h away → post-now with staleness warning (the deliberate gap).
test('in-window with too-little runway + long overnight gap → post-now', () => {
  const now = new Date('2026-08-14T19:30:00Z'); // Fri 15:30 ET
  const r = decide(now, CONFIG);
  assert.equal(r.action, 'post-now');
  assert.match(r.reason, /staleness/);
});

// Sat 07:00 ET → 1h until Sat 08:00 window → defer.
test('defer: overnight into a morning window (within maxDeferHours)', () => {
  const now = new Date('2026-08-15T11:00:00Z'); // Sat 07:00 ET
  const r = decide(now, CONFIG);
  assert.equal(r.action, 'defer');
  // Sat 08:02 ET = Sat 12:02 UTC (still EDT)
  assert.equal(new Date(r.runAt).toISOString(), '2026-08-15T12:02:00.000Z');
});

// DST fall-back is Sun 2026-11-01 02:00 ET → 01:00 ET (America/New_York).
// Sun 03:00 ET post-transition = 08:00 UTC. Next window is Tue 11:00 ET.
// Post-transition Tue 11:00 ET is EST (UTC-5), so it's Tue 16:00 UTC.
// From Sun 08:00 UTC to Tue 16:00 UTC = 56h → post-now.
test('DST fall-back: TZ math still finds the correct next window', () => {
  const now = new Date('2026-11-01T08:00:00Z'); // Sun 03:00 EST (after fall-back)
  const r = decide(now, CONFIG);
  assert.equal(r.action, 'post-now'); // too far to defer
  // Sanity: findNextWindow should have identified Tue 11:00 (via reason string)
  assert.match(r.reason, /tue 11:00/);
});

// Sat 22:30 ET → in Sat 22-23 window with 30 min left (< 35). Next is Tue
// 11:00 ET, ~60h away → post-now with staleness.
test('in-window Sat night with too-little runway → post-now (weekend gap)', () => {
  const now = new Date('2026-08-16T02:30:00Z'); // Sat 22:30 ET
  const r = decide(now, CONFIG);
  assert.equal(r.action, 'post-now');
  assert.match(r.reason, /staleness/);
});

// Wed 09:30 ET → 30 min until Wed 10:00 window → defer.
test('defer: 30 minutes out from a nearby window', () => {
  const now = new Date('2026-08-12T13:30:00Z'); // Wed 09:30 ET
  const r = decide(now, CONFIG);
  assert.equal(r.action, 'defer');
  assert.equal(new Date(r.runAt).toISOString(), '2026-08-12T14:02:00.000Z');
});

test('empty windows array falls back to post-now', () => {
  const r = decide(new Date(), { ...CONFIG, windows: [] });
  assert.equal(r.action, 'post-now');
});
