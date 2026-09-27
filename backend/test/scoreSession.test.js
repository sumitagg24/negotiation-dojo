/**
 * Tests for scoreSession.js (spec B.6) and the session store (spec B.7).
 *
 * Covers the claims that matter most:
 *  - final_score is ALWAYS deterministic and never taken from the LLM
 *  - malformed LLM JSON retries once, then falls back (part F)
 *  - an empty session renders a real scorecard instead of crashing (part F)
 *  - the narrative prompt is not corrupted by dollar figures
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");

// Point the fallback persistence at a scratch file before the store loads.
process.env.SESSION_STORE_PATH = path.join(os.tmpdir(), `nd-test-sessions-${process.pid}.json`);

const {
  scoreSession,
  computeSubScores,
  computeFinalScore,
  scoreLabelFor,
  buildScorecardPrompt,
  createLlmClient,
  stripCodeFences,
} = require("../src/scoring/scoreSession");

const sessionStore = require("../src/store/sessionStore");

function makeStore({ moves = [], tells = [], scenarioConfig = { candidateTargetSalary: 100000 } } = {}) {
  let scorecard = null;
  return {
    getMoves: () => moves,
    getTells: () => tells,
    getScenarioConfig: () => scenarioConfig,
    setScorecard: (_id, value) => {
      scorecard = value;
      return value;
    },
    getScorecard: () => scorecard,
  };
}

const VALID_NARRATIVE = {
  went_well: [{ quote: "I'd like to start around $110,000.", note: "Clear anchor with no apology." }],
  biggest_leverage_loss: { quote: "I could probably do $100,000.", note: "Dropped $10k with nothing asked back." },
  tells: [],
  next_time_instruction: "Count to five before filling their silence.",
};

// ---------------------------------------------------------------------------
// Deterministic sub-scores
// ---------------------------------------------------------------------------

test("computeSubScores scores a clean anchored-and-reciprocal session at the top", () => {
  const moves = [
    { id: "m1", move_type: "anchor", number_mentioned: 110000, asked_for_reciprocity: false },
    { id: "m2", move_type: "concession", number_mentioned: 100000, asked_for_reciprocity: true },
  ];
  const sub = computeSubScores(moves, [], { candidateTargetSalary: 100000 });

  assert.equal(sub.anchorQuality, 1.0);
  assert.equal(sub.reciprocityRatio, 1.0);
  assert.equal(sub.tellDensity, 0);
  assert.equal(sub.finalOutcomeRatio, 1.0);
});

test("computeSubScores only credits anchoring first if the first move actually anchored", () => {
  const moves = [
    { id: "m1", move_type: "question", quote: "What does the band look like?" },
    { id: "m2", move_type: "anchor", number_mentioned: 110000 },
  ];
  const sub = computeSubScores(moves, [], { candidateTargetSalary: 100000 });
  assert.equal(sub.anchorQuality, 0.4, "anchoring after a question is not anchoring first");
});

test("computeSubScores does not penalise a session that needed no concessions", () => {
  const sub = computeSubScores([{ id: "m1", move_type: "acceptance" }], [], { candidateTargetSalary: 100000 });
  assert.equal(sub.reciprocityRatio, 1.0);
});

test("computeSubScores clamps tell density so it cannot invert the scale", () => {
  // More tells than moves would otherwise push 1 - tellDensity negative.
  const moves = [{ id: "m1", move_type: "anchor" }];
  const tells = [{ type: "hesitation" }, { type: "pace_spike" }, { type: "retraction" }];
  const sub = computeSubScores(moves, tells, { candidateTargetSalary: 100000 });
  assert.equal(sub.tellDensity, 1, "clamped to 1");
});

// ---------------------------------------------------------------------------
// Final score
// ---------------------------------------------------------------------------

test("computeFinalScore applies the documented weights", () => {
  const score = computeFinalScore({
    anchorQuality: 1.0,
    reciprocityRatio: 1.0,
    tellDensity: 0,
    finalOutcomeRatio: 1.0,
  });
  // 0.30 + 0.30 + 0.25 + (1/1.15)*0.15 == 0.9804 -> 98
  assert.equal(score, 98);
});

test("computeFinalScore caps an outcome beyond the ceiling instead of breaking the scale", () => {
  const capped = computeFinalScore({
    anchorQuality: 1, reciprocityRatio: 1, tellDensity: 0, finalOutcomeRatio: 1.15,
  });
  const wild = computeFinalScore({
    anchorQuality: 1, reciprocityRatio: 1, tellDensity: 0, finalOutcomeRatio: 5,
  });
  assert.equal(capped, wild);
  assert.ok(wild <= 100, `score must not exceed 100, got ${wild}`);
});

test("computeFinalScore uses a neutral outcome when no number was ever settled", () => {
  const score = computeFinalScore({
    anchorQuality: 0.4, reciprocityRatio: 1.0, tellDensity: 0, finalOutcomeRatio: null,
  });
  // 0.4*0.30 + 1.0*0.30 + 1*0.25 + 0.5*0.15 == 0.745 -> 75? No: 0.12+0.30+0.25+0.075 == 0.745
  assert.equal(score, 75);
});

test("computeFinalScore scores a session with zero moves at zero, not at a neutral 75", () => {
  // The untouched terms all sit at their neutral maxima, so the raw formula would
  // hand a silent session 75/100 ("Strong negotiator").
  const silent = computeFinalScore(
    { anchorQuality: 0.4, reciprocityRatio: 1.0, tellDensity: 0, finalOutcomeRatio: null },
    0,
  );
  assert.equal(silent, 0);
});

test("scoreLabelFor uses the spec C.4 bands", () => {
  assert.equal(scoreLabelFor(75), "Strong negotiator");
  assert.equal(scoreLabelFor(100), "Strong negotiator");
  assert.equal(scoreLabelFor(74), "Solid, room to grow");
  assert.equal(scoreLabelFor(50), "Solid, room to grow");
  assert.equal(scoreLabelFor(49), "Left money on the table");
  assert.equal(scoreLabelFor(0), "Left money on the table");
});

// ---------------------------------------------------------------------------
// The authority rule
// ---------------------------------------------------------------------------

test("scoreSession ignores any final_score the LLM invents", async () => {
  const store = makeStore({
    moves: [
      { id: "m1", move_type: "anchor", number_mentioned: 110000, quote: "I'd like $110,000." },
      { id: "m2", move_type: "concession", number_mentioned: 100000, asked_for_reciprocity: true, quote: "I can do $100,000." },
    ],
  });

  const llmClient = {
    isConfigured: () => true,
    complete: async () => JSON.stringify({ ...VALID_NARRATIVE, final_score: 999, score_label: "Legendary" }),
  };

  const scorecard = await scoreSession("s1", store, llmClient);

  assert.equal(scorecard.final_score, 98, "the deterministic score must win");
  assert.equal(scorecard.score_label, "Strong negotiator", "the LLM must not control the label");
  assert.equal(scorecard.narrative_source, "llm");
});

// ---------------------------------------------------------------------------
// Malformed JSON handling (part F)
// ---------------------------------------------------------------------------

test("scoreSession retries once with a stricter reminder after malformed JSON", async () => {
  const store = makeStore({ moves: [{ id: "m1", move_type: "anchor", number_mentioned: 110000, quote: "Anchor." }] });

  const prompts = [];
  const llmClient = {
    isConfigured: () => true,
    complete: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 1) return "Sure! Here you go:\n```json\n{ this is not valid json }\n```";
      return JSON.stringify(VALID_NARRATIVE);
    },
  };

  const scorecard = await scoreSession("s2", store, llmClient);

  assert.equal(prompts.length, 2, "should retry exactly once");
  assert.ok(prompts[0].includes("SESSION DATA:"), "first attempt uses the plain prompt");
  assert.ok(
    prompts[1].includes("Output ONLY the JSON object, nothing else"),
    "retry appends the stricter reminder",
  );
  assert.equal(scorecard.narrative_source, "llm");
  assert.equal(
    scorecard.biggest_leverage_loss.note,
    VALID_NARRATIVE.biggest_leverage_loss.note,
    "the second attempt's content should be used",
  );
});

test("scoreSession falls back to a deterministic narrative when the LLM never returns JSON", async () => {
  const store = makeStore({
    moves: [
      { id: "m1", move_type: "anchor", number_mentioned: 110000, quote: "I want $110,000." },
      { id: "m2", move_type: "concession", number_mentioned: 98000, asked_for_reciprocity: false, quote: "Okay, $98,000." },
    ],
    tells: [{ type: "hesitation", gapMs: 1500, atWord: "ninety eight thousand", quote: "Okay, $98,000." }],
  });

  let calls = 0;
  const llmClient = {
    isConfigured: () => true,
    complete: async () => {
      calls += 1;
      return "I'm sorry, I can't help with that.";
    },
  };

  const scorecard = await scoreSession("s3", store, llmClient);

  assert.equal(calls, 2, "two attempts before giving up");
  assert.equal(scorecard.narrative_source, "fallback");
  // The contract still holds in full.
  assert.ok(typeof scorecard.final_score === "number");
  assert.ok(typeof scorecard.score_label === "string");
  assert.ok(Array.isArray(scorecard.went_well));
  assert.ok(Array.isArray(scorecard.tells));
  assert.equal(typeof scorecard.next_time_instruction, "string");
  assert.ok(scorecard.biggest_leverage_loss, "the unreciprocated concession is the leverage loss");
  assert.equal(scorecard.biggest_leverage_loss.quote, "Okay, $98,000.");
  assert.equal(scorecard.tells.length, 1);
  assert.match(scorecard.tells[0].note, /1\.5 seconds/);
});

test("scoreSession skips the LLM entirely when no key is configured", async () => {
  const store = makeStore({ moves: [{ id: "m1", move_type: "anchor", number_mentioned: 110000, quote: "Anchor." }] });

  let calls = 0;
  const llmClient = {
    isConfigured: () => false,
    complete: async () => {
      calls += 1;
      return "{}";
    },
  };

  const scorecard = await scoreSession("s4", store, llmClient);
  assert.equal(calls, 0);
  assert.equal(scorecard.narrative_source, "fallback");
});

// ---------------------------------------------------------------------------
// Empty sessions (part F)
// ---------------------------------------------------------------------------

test("an empty session renders a valid scorecard at zero instead of crashing", async () => {
  const store = makeStore({ moves: [], tells: [] });
  const scorecard = await scoreSession("s5", store, { isConfigured: () => false });

  assert.equal(scorecard.final_score, 0);
  assert.equal(scorecard.score_label, "Left money on the table");
  assert.deepEqual(scorecard.went_well, []);
  assert.equal(scorecard.biggest_leverage_loss, null);
  assert.deepEqual(scorecard.tells, []);
  assert.ok(scorecard.next_time_instruction.length > 0);
});

test("a session with moves but no tells reports no tells", async () => {
  const store = makeStore({ moves: [{ id: "m1", move_type: "anchor", number_mentioned: 110000, quote: "Anchor." }] });
  const scorecard = await scoreSession("s6", store, { isConfigured: () => false });
  assert.deepEqual(scorecard.tells, []);
  assert.equal(scorecard.biggest_leverage_loss, null, "no concessions means no leverage loss to report");
});

// ---------------------------------------------------------------------------
// Prompt integrity
// ---------------------------------------------------------------------------

test("buildScorecardPrompt embeds the three payloads verbatim", () => {
  const moveLog = [{ id: "m1", move_type: "anchor", number_mentioned: 95000, quote: "I'd like $95,000, given the scope." }];
  const prompt = buildScorecardPrompt({
    moveLog,
    tellLog: [],
    subScores: { anchorQuality: 1, reciprocityRatio: 1, tellDensity: 0, finalOutcomeRatio: 0.95 },
    finalScore: 96,
  });

  assert.ok(!prompt.includes("{{move_log_json}}"), "placeholder must be substituted");
  assert.ok(!prompt.includes("{{sub_scores_json}}"));
  assert.ok(!prompt.includes("{{tells_json}}"));
  assert.ok(prompt.includes('"number_mentioned":95000'), "the move log must survive intact");
});

test("buildScorecardPrompt is not corrupted by dollar figures or $ replacement patterns", () => {
  // A naive String.replace would expand "$&" and "$$" inside the JSON payload.
  const prompt = buildScorecardPrompt({
    moveLog: [{ id: "m1", move_type: "anchor", quote: "I need $95,000, or $& more, honestly $$." }],
    tellLog: [],
    subScores: {},
    finalScore: 50,
  });
  assert.ok(
    prompt.includes("I need $95,000, or $& more, honestly $$."),
    "dollar amounts and $ patterns must be preserved literally",
  );
});

test("stripCodeFences unwraps fenced and chatty JSON", () => {
  assert.equal(stripCodeFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFences('Here you go: {"a":1} hope that helps'), '{"a":1}');
  assert.equal(stripCodeFences('{"a":1}'), '{"a":1}');
});

test("createLlmClient defaults to the AssemblyAI LLM Gateway with the shared key", () => {
  const client = createLlmClient({ ASSEMBLYAI_API_KEY: "abc123" });
  assert.equal(client.isConfigured(), true);
  assert.equal(client.model, "qwen3.5-4b-32k-fast");
  assert.equal(createLlmClient({}).isConfigured(), false);
});

// ---------------------------------------------------------------------------
// Store baseline (spec B.7)
// ---------------------------------------------------------------------------

test("updateBaseline keeps a correct rolling average of pace and confidence", () => {
  const id = sessionStore.createSession({ candidateTargetSalary: 100000 });

  sessionStore.updateBaseline(id, { wordsPerSecond: 2, confidence: 0.8 });
  sessionStore.updateBaseline(id, { wordsPerSecond: 4, confidence: 0.9 });
  const baseline = sessionStore.updateBaseline(id, { wordsPerSecond: 6, confidence: 1.0 });

  assert.equal(baseline.avgWordsPerSecond, 4, "(2+4+6)/3");
  assert.ok(Math.abs(baseline.avgConfidence - 0.9) < 1e-9, `(0.8+0.9+1.0)/3, got ${baseline.avgConfidence}`);
  assert.equal(baseline.utteranceCount, 3);
});

test("appendTell stamps an id and a timestamp so tells can be interleaved with moves", () => {
  const id = sessionStore.createSession({ candidateTargetSalary: 100000 });
  const stored = sessionStore.appendTell(id, { type: "hesitation", gapMs: 1400, quote: "um, ninety five thousand" });

  assert.ok(stored.id);
  assert.ok(typeof stored.timestamp === "number");
  assert.equal(sessionStore.getTells(id).length, 1);
});

test("appendMove and getMoves round-trip the move log", () => {
  const id = sessionStore.createSession({ candidateTargetSalary: 100000 });
  sessionStore.appendMove(id, { id: "m1", move_type: "anchor", number_mentioned: 110000 });
  assert.equal(sessionStore.getMoves(id).length, 1);
  assert.equal(sessionStore.getMoves(id)[0].number_mentioned, 110000);
});

test("the store returns safe defaults for an unknown session id", () => {
  assert.deepEqual(sessionStore.getMoves("nope"), []);
  assert.deepEqual(sessionStore.getTells("nope"), []);
  assert.equal(sessionStore.getScenarioConfig("nope"), null);
  assert.equal(sessionStore.getScorecard("nope"), null);
  assert.equal(sessionStore.getBaseline("nope").utteranceCount, 0);
});
