// Scheduling decision for the auto-poster. Pure module: no I/O, no side effects.
//
// decide(now, config) → { action: 'post-now' | 'defer', runAt?, reason, window? }
//
// Rules (matching the design conversation):
//   1. If now is inside an active window with ≥ minRemainingMinutes of runway left → post-now.
//   2. Else look for the next window that starts within maxDeferHours → defer to it.
//   3. Else (next window too far, content would go stale) → post-now with a warning reason.
//
// Windows are wall-clock times in `config.timezone`. All TZ math is done via
// Intl.DateTimeFormat so DST is handled correctly.

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_INDEX = Object.fromEntries(DAY_NAMES.map((n, i) => [n, i]));

function parseHM(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function getPartsInTz(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  // 'en-US' with hour12:false emits '24' for midnight in some environments.
  let hour = get('hour');
  if (hour === 24) hour = 0;
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
}

function getDayOfWeekInTz(date, timezone) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date);
  return s.toLowerCase();
}

// Given a wall-clock time in a target TZ, compute the UTC instant. Uses the
// "format-and-diff" trick: format the guess in the target TZ, see what wall
// clock we get, adjust by the delta. Two passes handle DST transitions.
function wallClockToUtc(year, month, day, hour, minute, timezone) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const p = getPartsInTz(new Date(utcMs), timezone);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const want = Date.UTC(year, month - 1, day, hour, minute);
    const delta = want - got;
    if (delta === 0) break;
    utcMs += delta;
  }
  return utcMs;
}

function addDaysToYmd({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function findNextWindow(now, config) {
  const { timezone, windows } = config;
  const nowParts = getPartsInTz(now, timezone);
  const nowDayIdx = DAY_INDEX[getDayOfWeekInTz(now, timezone)];
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;

  for (let dOffset = 0; dOffset < 8; dOffset++) {
    const candidateDayName = DAY_NAMES[(nowDayIdx + dOffset) % 7];
    const dayCandidates = [];
    for (const w of windows) {
      if (w.day !== candidateDayName) continue;
      const startM = parseHM(w.start);
      // Skip windows on today whose start is at or before now — they're either
      // active (handled by the caller) or already past.
      if (dOffset === 0 && startM <= nowMinutes) continue;
      const target = addDaysToYmd(nowParts, dOffset);
      const [h, m] = w.start.split(':').map(Number);
      const utcMs = wallClockToUtc(target.year, target.month, target.day, h, m, timezone);
      dayCandidates.push({ window: w, utcMs });
    }
    if (dayCandidates.length) {
      dayCandidates.sort((a, b) => a.utcMs - b.utcMs);
      // Offset by 2 min so we post *just inside* the window (matches the
      // "post early in the block" heuristic and avoids clock-skew races).
      return { window: dayCandidates[0].window, runAtUtcMs: dayCandidates[0].utcMs + 2 * 60 * 1000 };
    }
  }
  throw new Error('No active windows configured');
}

export function decide(now, config) {
  const { timezone, minRemainingMinutes, maxDeferHours, windows } = config;
  if (!Array.isArray(windows) || windows.length === 0) {
    return { action: 'post-now', reason: 'No windows configured; scheduling disabled.', window: null };
  }

  const nowParts = getPartsInTz(now, timezone);
  const nowDay = getDayOfWeekInTz(now, timezone);
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;

  const currentWindow = windows.find((w) =>
    w.day === nowDay &&
    nowMinutes >= parseHM(w.start) &&
    nowMinutes < parseHM(w.end),
  );

  if (currentWindow) {
    const remaining = parseHM(currentWindow.end) - nowMinutes;
    if (remaining >= minRemainingMinutes) {
      return {
        action: 'post-now',
        reason: `In active window (${currentWindow.day} ${currentWindow.start}-${currentWindow.end}); ${remaining} min remaining ≥ ${minRemainingMinutes} min minimum.`,
        window: currentWindow,
      };
    }
    // Fall through to defer-vs-post-now decision.
  }

  const next = findNextWindow(now, config);
  const hoursUntil = (next.runAtUtcMs - now.getTime()) / 3_600_000;

  if (hoursUntil <= maxDeferHours) {
    const reason = currentWindow
      ? `Only ${parseHM(currentWindow.end) - nowMinutes} min left in current window (< ${minRemainingMinutes} min); deferring to next window ${next.window.day} ${next.window.start} in ${hoursUntil.toFixed(1)}h.`
      : `Not in an active window; deferring to next window ${next.window.day} ${next.window.start} in ${hoursUntil.toFixed(1)}h.`;
    return {
      action: 'defer',
      runAt: new Date(next.runAtUtcMs).toISOString(),
      reason,
      window: next.window,
    };
  }

  return {
    action: 'post-now',
    reason: `Next active window ${next.window.day} ${next.window.start} is ${hoursUntil.toFixed(1)}h away (> maxDeferHours=${maxDeferHours}); posting now to avoid staleness.`,
    window: null,
  };
}
