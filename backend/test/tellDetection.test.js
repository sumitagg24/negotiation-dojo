/**
 * Tests for the tell detectors (spec B.5).
 *
 * Part E acceptance row 4 requires that at least 3 of the 4 detectors fire
 * correctly on a scripted utterance designed to trigger each one. These cases
 * are that evidence, and they are runnable: `npm test` in backend/.
 *
 * Not part of the spec's Part G file tree, but Part E explicitly requires
 * verifying the detectors, and reproducible evidence beats a one-off manual check.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectTells,
  detectHesitationBeforeNumber,
  detectRetraction,
  detectPaceSpike,
  detectMumbledNumber,
  isNumberToken,
  parseNumber,
  reconstructQuote,
  extractNumberMentions,
  computeUtteranceStats,
} = require("../src/scoring/tellDetection");

/** Compact word builder: w("ninety", 2400, 2700, 0.99) */
function w(text, start, end, confidence = 0.99) {
  return { text, start, end, confidence };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test("isNumberToken matches digits, currency, k-suffix and spelled numbers", () => {
  for (const t of ["92000", "$92,000", "92k", "95", "ninety", "five", "thousand", "ninety-five", "1.5m"]) {
    assert.equal(isNumberToken(t), true, `expected ${t} to be a number token`);
  }
  for (const t of ["I", "the", "offer", "band", "no", "a", "and", "flexibility"]) {
    assert.equal(isNumberToken(t), false, `expected ${t} NOT to be a number token`);
  }
});

test("parseNumber normalises every supported form to a plain integer", () => {
  assert.equal(parseNumber("$92,000"), 92000);
  assert.equal(parseNumber("92k"), 92000);
  assert.equal(parseNumber("ninety five thousand"), 95000);
  assert.equal(parseNumber("ninety thousand"), 90000);
  assert.equal(parseNumber("one hundred and twenty thousand"), 120000);
  assert.equal(parseNumber("ninety-five"), 95);
  assert.equal(parseNumber("110000"), 110000);
  assert.equal(parseNumber("not a number"), null);
});

test("extractNumberMentions merges a multi-token spoken figure into one mention", () => {
  const words = [w("around", 0, 400), w("ninety", 400, 700), w("five", 700, 900), w("thousand", 900, 1300)];
  const mentions = extractNumberMentions(words);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].value, 95000);
  assert.equal(mentions[0].text, "ninety five thousand");
});

// ---------------------------------------------------------------------------
// Detector 1: hesitation
// ---------------------------------------------------------------------------

test("detectHesitationBeforeNumber fires on a long pause before the figure", () => {
  const words = [
    w("I", 0, 100), w("was", 100, 250), w("thinking", 250, 600), w("around", 600, 900),
    // 1500ms of silence, then the number
    w("ninety", 2400, 2700), w("five", 2700, 2900), w("thousand", 2900, 3400),
  ];
  const tell = detectHesitationBeforeNumber(words);
  assert.ok(tell, "expected a hesitation tell");
  assert.equal(tell.type, "hesitation");
  assert.equal(tell.gapMs, 1500);
  assert.equal(tell.atWord, "ninety five thousand");
});

test("detectHesitationBeforeNumber stays quiet on a fluent delivery", () => {
  const words = [w("around", 0, 400), w("ninety", 450, 700), w("thousand", 700, 1000)];
  assert.equal(detectHesitationBeforeNumber(words), null);
});

// ---------------------------------------------------------------------------
// Detector 2: retraction
// ---------------------------------------------------------------------------

test("detectRetraction fires when the user walks a number back", () => {
  const words = [
    w("I", 0, 100), w("mean", 100, 300), w("make", 300, 500), w("it", 500, 600),
    w("ninety", 600, 900), w("five", 900, 1100), w("thousand", 1100, 1500),
    w("no", 1500, 1700), w("sorry", 1700, 1900),
    w("ninety", 1900, 2200), w("thousand", 2200, 2600),
  ];
  const tell = detectRetraction(words);
  assert.ok(tell, "expected a retraction tell");
  assert.equal(tell.type, "retraction");
  assert.equal(tell.from, 95000);
  assert.equal(tell.to, 90000);
});

test("detectRetraction stays quiet when the same figure is repeated", () => {
  const words = [
    w("ninety", 0, 300), w("thousand", 300, 700),
    w("ninety", 800, 1100), w("thousand", 1100, 1500),
  ];
  assert.equal(detectRetraction(words), null);
});

// ---------------------------------------------------------------------------
// Detector 3: pace spike
// ---------------------------------------------------------------------------

test("detectPaceSpike fires when the user speeds up past their own baseline", () => {
  const words = Array.from({ length: 10 }, (_, i) => w(`word${i}`, i * 100, i * 100 + 100));
  const tell = detectPaceSpike(words, { avgWordsPerSecond: 2 });
  assert.ok(tell, "expected a pace spike tell");
  assert.equal(tell.type, "pace_spike");
  assert.equal(tell.wordsPerSecond, 10);
  assert.equal(tell.baseline, 2);
});

test("detectPaceSpike stays quiet without an established baseline", () => {
  const words = Array.from({ length: 10 }, (_, i) => w(`word${i}`, i * 100, i * 100 + 100));
  assert.equal(detectPaceSpike(words, { avgWordsPerSecond: 0 }), null);
});

test("detectPaceSpike stays quiet when speaking at the established baseline", () => {
  // 5 words over 2.5s == 2 words/sec, exactly the baseline
  const words = Array.from({ length: 5 }, (_, i) => w(`word${i}`, i * 500, i * 500 + 500));
  assert.equal(detectPaceSpike(words, { avgWordsPerSecond: 2 }), null);
});

// ---------------------------------------------------------------------------
// Detector 4: mumbled number
// ---------------------------------------------------------------------------

test("detectMumbledNumber fires when the figure is the least confident part", () => {
  const words = [
    w("I", 0, 200, 0.99), w("think", 200, 400, 0.99), w("maybe", 400, 600, 0.99),
    w("ninety", 600, 900, 0.6), w("five", 900, 1100, 0.6), w("thousand", 1100, 1500, 0.6),
  ];
  const tell = detectMumbledNumber(words);
  assert.ok(tell, "expected a mumbled_number tell");
  assert.equal(tell.type, "mumbled_number");
  assert.equal(tell.numberConfidence, 0.6);
  assert.ok(tell.avgConfidence - tell.numberConfidence > 0.15);
});

test("detectMumbledNumber stays quiet on a clearly delivered figure", () => {
  const words = [
    w("I", 0, 200, 0.95), w("was", 200, 400, 0.93),
    w("ninety", 400, 700, 0.97), w("thousand", 700, 1100, 0.98),
  ];
  assert.equal(detectMumbledNumber(words), null);
});

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

test("detectTells reports only the detectors that actually fired", () => {
  const hesitation = [
    w("I", 0, 100), w("was", 100, 250), w("thinking", 250, 600), w("around", 600, 900),
    w("ninety", 2400, 2700), w("five", 2700, 2900), w("thousand", 2900, 3400),
  ];
  const fired = detectTells(hesitation, { avgWordsPerSecond: 0 });
  assert.deepEqual(fired.map((t) => t.type), ["hesitation"]);

  const mumbled = [
    w("I", 0, 200, 0.99), w("think", 200, 400, 0.99), w("maybe", 400, 600, 0.99),
    w("ninety", 600, 900, 0.6), w("five", 900, 1100, 0.6), w("thousand", 1100, 1500, 0.6),
  ];
  assert.deepEqual(detectTells(mumbled, {}).map((t) => t.type), ["mumbled_number"]);
});

test("detectTells returns an empty array for a clean utterance", () => {
  // 5 words over 1.1s == 4.5 words/sec, so the baseline must sit above
  // 4.5 / 1.4 == 3.21 for this delivery to read as normal pace.
  const words = [w("Okay", 0, 200), w("that", 200, 400), w("works", 400, 700), w("for", 700, 900), w("me", 900, 1100)];
  assert.deepEqual(detectTells(words, { avgWordsPerSecond: 5 }), []);
});

test("detectTells can fire several detectors on one messy utterance", () => {
  const words = [
    w("I", 0, 100, 0.99), w("was", 100, 250, 0.99), w("thinking", 250, 600, 0.99),
    // hesitation gap, then a low-confidence number that is then retracted
    w("ninety", 2200, 2500, 0.55), w("five", 2500, 2700, 0.55), w("thousand", 2700, 3100, 0.55),
    w("no", 3100, 3300, 0.99), w("sorry", 3300, 3500, 0.99),
    w("ninety", 3500, 3800, 0.99), w("thousand", 3800, 4200, 0.99),
  ];
  // 10 words over 4.2s == 2.38 words/sec; baseline 2.5 keeps pace out of the
  // result so this case isolates the other three detectors.
  const types = detectTells(words, { avgWordsPerSecond: 2.5 }).map((t) => t.type).sort();
  assert.deepEqual(types, ["hesitation", "mumbled_number", "retraction"]);
});

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

test("computeUtteranceStats produces the rolling-baseline inputs", () => {
  const words = Array.from({ length: 10 }, (_, i) => w(`word${i}`, i * 100, i * 100 + 100, 0.9));
  const stats = computeUtteranceStats(words);
  assert.equal(stats.wordsPerSecond, 10);
  assert.ok(Math.abs(stats.confidence - 0.9) < 1e-9, `confidence was ${stats.confidence}`);
});

test("reconstructQuote rebuilds the user's exact words", () => {
  const words = [w("around", 0, 400), w("ninety", 400, 700), w("thousand", 700, 1000)];
  assert.equal(reconstructQuote(words), "around ninety thousand");
});
