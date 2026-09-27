/**
 * Pure marker-placement helpers for the FDR strip.
 *
 * The backend's tell_detected message carries { tellType, quote } but no word
 * offsets, so the strip estimates which client-measured moment the detection
 * refers to by looking backward through the traces. These helpers are pure
 * functions so they can be sanity-checked without a browser.
 *
 * Every finder returns -1 when nothing plausible is found inside the lookback
 * window; the caller then falls back to the detection-arrival playhead. The
 * marker still appears either way — it is only ever a display annotation, and
 * the client never runs its own tell detection.
 */

/**
 * Hesitation: the moment speech resumed after the most recent deep pause.
 * The pause trace reads ~0 while voiced and grows through silence, so the
 * last sample above 0.5 is the tail of the silence; the resumption is the
 * sample right after it.
 */
export function findPauseEnd(series, from, lookback) {
  const start = Math.max(0, from - lookback);
  for (let i = from; i >= start; i -= 1) {
    if ((series[i] || 0) > 0.5) return Math.min(from, i + 1);
  }
  return -1;
}

/** Pace spike: the highest pace value in the recent window. */
export function findPacePeak(series, from, lookback) {
  const start = Math.max(0, from - lookback);
  let best = -1;
  let bestValue = -1;
  for (let i = start; i <= from; i += 1) {
    const value = series[i] || 0;
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  // Ignore flat, quiet windows: a "peak" of nothing is not a moment.
  return bestValue > 0.15 ? best : -1;
}

/** Retraction: the most recent speech onset (the audible restart). */
export function findLastOnset(onsets, from) {
  let found = -1;
  for (let i = 0; i < onsets.length; i += 1) {
    if (onsets[i] <= from) found = onsets[i];
    else break;
  }
  return found;
}

/** Mumbled number: the softest audible moment in the recent window. */
export function findLevelDip(series, from, lookback) {
  const start = Math.max(0, from - lookback);
  let best = -1;
  let bestValue = Infinity;
  for (let i = start; i <= from; i += 1) {
    const value = series[i] || 0;
    // Above the silence floor (a pure gap is not a mumble) but genuinely soft.
    if (value > 0.008 && value < bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return bestValue < 0.06 ? best : -1;
}

/**
 * Which trace each tell kind is read against, and how far back to search.
 * lookback is in 50 ms samples: 80 samples = 4 s.
 */
export const FLAG_KINDS = {
  hesitation: {
    trace: "pause",
    find: (data, from, onsets) => findPauseEnd(data.pause, from, 80),
  },
  pace_spike: {
    trace: "pace",
    find: (data, from) => findPacePeak(data.pace, from, 60),
  },
  retraction: {
    trace: "pace",
    find: (data, from, onsets) => findLastOnset(onsets || [], from),
  },
  mumbled_number: {
    trace: "level",
    find: (data, from) => findLevelDip(data.level, from, 80),
  },
};
