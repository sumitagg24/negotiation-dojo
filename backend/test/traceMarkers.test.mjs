/**
 * Tests for the FDR strip's marker-placement helpers (frontend/src/lib).
 *
 * These helpers estimate which client-measured trace moment a backend tell
 * detection refers to. They are pure functions, so they are tested directly
 * in Node. This file is .mjs so it can statically import the frontend's ESM
 * module while living inside the CommonJS backend package.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  findPauseEnd,
  findPacePeak,
  findLastOnset,
  findLevelDip,
  FLAG_KINDS,
} from "../../frontend/src/lib/traceMarkers.js";

test("findPauseEnd returns the moment speech resumed after the deepest recent pause", () => {
  const pause = [0, 0, 0.7, 0.9, 0, 0.1, 0.2];
  assert.equal(findPauseEnd(pause, 6, 80), 4);
});

test("findPauseEnd falls back to -1 when no deep pause exists in the window", () => {
  const pause = [0, 0.1, 0, 0.2, 0];
  assert.equal(findPauseEnd(pause, 4, 80), -1);
});

test("findPacePeak returns the highest pace sample in the window", () => {
  const pace = [0.1, 0.2, 0.8, 0.7, 0.3];
  assert.equal(findPacePeak(pace, 4, 60), 2);
});

test("findPacePeak rejects flat, quiet windows instead of inventing a peak", () => {
  assert.equal(findPacePeak([0.05, 0.05], 1, 60), -1);
});

test("findLastOnset returns the most recent onset at or before the detection", () => {
  assert.equal(findLastOnset([3, 11, 20], 25), 20);
  assert.equal(findLastOnset([3, 11, 20], 15), 11);
});

test("findLastOnset returns -1 when no onset precedes the detection", () => {
  assert.equal(findLastOnset([3, 11], 2), -1);
});

test("findLevelDip finds the softest audible moment, skipping true silence", () => {
  // 0.01 is audible (above the 0.008 floor) and the strict minimum -> index 2.
  const level = [0.05, 0.02, 0.01, 0.03, 0.05];
  assert.equal(findLevelDip(level, 4, 80), 2);
  // A hard silence (0) is a gap, not a mumble, and is never selected.
  assert.equal(findLevelDip([0.05, 0.02, 0, 0.03, 0.05], 4, 80), 1);
});

test("findLevelDip falls back to -1 when everything audible is loud", () => {
  assert.equal(findLevelDip([0.2, 0.3], 1, 80), -1);
});

test("every backend tell type maps to a trace and a finder", () => {
  for (const kind of ["hesitation", "retraction", "pace_spike", "mumbled_number"]) {
    const spec = FLAG_KINDS[kind];
    assert.ok(spec, `${kind} has a mapping`);
    assert.ok(["level", "pace", "pause"].includes(spec.trace), `${kind} targets a real trace`);
    assert.equal(typeof spec.find, "function", `${kind} has a finder`);
  }
  assert.equal(Object.keys(FLAG_KINDS).length, 4, "no stray mappings");
});
