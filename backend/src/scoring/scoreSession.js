/**
 * scoreSession.js
 *
 * Deterministic sub-scores + ONE LLM call for the narrative prose.
 *
 * Spec: negotiation_dojo_full_spec.md section B.6 (and prompts from D.3)
 *
 * CRITICAL RULE: `final_score` is ALWAYS computed deterministically in
 * computeFinalScore and never taken from the LLM. The LLM call only turns
 * already-computed facts into readable prose. This is what lets you honestly say
 * "the score is not a black box, it's a weighted formula".
 */

// ---------------------------------------------------------------------------
// Deterministic scoring (spec B.6)
// ---------------------------------------------------------------------------

const WEIGHTS = {
  anchorQuality: 0.30,
  reciprocityRatio: 0.30,
  tellDensityInverted: 0.25,
  outcomeScore: 0.15,
};

function computeSubScores(moveLog, tellLog, scenarioConfig) {
  const moves = Array.isArray(moveLog) ? moveLog : [];
  const tells = Array.isArray(tellLog) ? tellLog : [];

  const concessions = moves.filter((m) => m.move_type === "concession");
  const reciprocalConcessions = concessions.filter((m) => m.asked_for_reciprocity === true);

  const userAnchoredFirst =
    moves.length > 0 &&
    moves.find((m) => m.move_type === "anchor" || m.move_type === "counter_offer")?.id === moves[0].id;

  const finalNumberMove = [...moves].reverse().find((m) => typeof m.number_mentioned === "number");
  const finalOutcomeRatio = finalNumberMove
    ? finalNumberMove.number_mentioned / scenarioConfig.candidateTargetSalary
    : null;

  // tell_density is defined as 0..1 with LOWER better. A talkative turn pattern
  // can produce more tells than moves (tellLog.length > moveLog.length), which
  // would push it above 1 and make `1 - tellDensity` negative in
  // computeFinalScore, so it is clamped to the documented range.
  const rawTellDensity = moves.length > 0 ? tells.length / moves.length : 0;

  return {
    anchorQuality: userAnchoredFirst ? 1.0 : 0.4, // 0..1
    reciprocityRatio:
      concessions.length > 0 ? reciprocalConcessions.length / concessions.length : 1.0, // 0..1
    tellDensity: Math.min(Math.max(rawTellDensity, 0), 1), // 0..1, LOWER is better
    finalOutcomeRatio, // e.g. 0.97 means they landed at 97% of target
  };
}

/**
 * @param {object} subScores
 * @param {number|null} moveCount Passed by scoreSession. When a session logged
 *   zero moves the candidate said essentially nothing, so there is no evidence of
 *   any negotiation skill. The spec's formula would otherwise award that session
 *   75/100 ("Strong negotiator") because the untouched terms score at their
 *   neutral maxima -- clearly wrong, and part F calls the empty-log case out as
 *   one that must be handled properly. Zero moves therefore scores zero.
 */
function computeFinalScore(subScores, moveCount = null) {
  if (moveCount === 0) return 0;

  const outcomeScore =
    subScores.finalOutcomeRatio !== null && subScores.finalOutcomeRatio !== undefined
      ? Math.min(subScores.finalOutcomeRatio, 1.15) / 1.15 // cap so wildly exceeding target doesn't break the scale
      : 0.5; // neutral if no number was ever settled

  const tellDensityInverted = 1 - subScores.tellDensity;

  const weighted =
    subScores.anchorQuality * WEIGHTS.anchorQuality +
    subScores.reciprocityRatio * WEIGHTS.reciprocityRatio +
    tellDensityInverted * WEIGHTS.tellDensityInverted +
    outcomeScore * WEIGHTS.outcomeScore;

  // The epsilon corrects binary floating-point representation error on exact
  // half-point totals. Without it a mathematically exact 74.5 accumulates as
  // 0.7449999999999999, rounds DOWN to 74, and flips the label from "Strong
  // negotiator" to "Solid, room to grow" for a score that should have earned it.
  // It is ~1e-9, far below any real score difference.
  return Math.round(weighted * 100 + 1e-9); // 0-100 final score
}

/** Bands from spec C.4, applied server-side so the LLM cannot contradict them. */
function scoreLabelFor(finalScore) {
  if (finalScore >= 75) return "Strong negotiator";
  if (finalScore >= 50) return "Solid, room to grow";
  return "Left money on the table";
}

// ---------------------------------------------------------------------------
// Prompt (spec D.3, verbatim with the three placeholders substituted)
// ---------------------------------------------------------------------------

const SCORECARD_PROMPT_TEMPLATE = `You are writing a post-session negotiation coaching report. You will be given:
1. The full list of logged negotiation moves from the session (each with a type, exact quote, and timestamp)
2. Computed sub-scores: anchor_quality, reciprocity_ratio, tell_density, final_outcome_ratio
3. A list of flagged "tells" (hesitation, retraction, pace spike, mumbled number) with the exact quote and timestamp each occurred at

Write a scorecard using plain, direct, slightly blunt coaching language — like a sharp negotiation coach, not a corporate HR bot. Do not be cruel, but do not soften real mistakes either.

Output ONLY valid JSON, no prose before or after, matching exactly this shape:
{
  "went_well": [ { "quote": string, "note": string } ],
  "biggest_leverage_loss": { "quote": string, "note": string },
  "tells": [ { "type": string, "quote": string, "note": string } ],
  "next_time_instruction": string
}

Rules:
- "went_well" should have 2-3 entries, each quoting the user's exact words from the move log.
- "biggest_leverage_loss" is the single worst moment — pick the concession with asked_for_reciprocity=false and the largest number_mentioned drop, or explain your reasoning if no number is involved.
- "tells" should list every entry from the tells data, translated into plain language (e.g. a hesitation entry becomes "You paused for 1.4 seconds before saying '$100,000' — that reads as a bluffable number.").
- "next_time_instruction" must be ONE concrete, specific action, not generic advice. Bad: "be more confident." Good: "next time, when they go quiet after your number, count to five silently before speaking again."
- Do NOT include a numeric score field — that is computed separately and will be added programmatically.

SESSION DATA:
{{move_log_json}}

COMPUTED SUB-SCORES:
{{sub_scores_json}}

TELLS DATA:
{{tells_json}}`;

const STRICTER_REMINDER =
  "\n\nIMPORTANT: Output ONLY the JSON object, nothing else. No markdown fences, no commentary, no preamble.";

function buildScorecardPrompt({ moveLog, tellLog, subScores, finalScore }) {
  // Function replacers are used deliberately: a string replacement would let
  // "$" sequences inside the JSON (dollar figures like "$95,000") be interpreted
  // as replace patterns such as $& or $$ and silently corrupt the prompt.
  const tellsForPrompt = (tellLog || []).map((t) => ({
    type: t.type,
    quote: t.quote,
    timestamp: t.timestamp,
    detail: Object.fromEntries(
      Object.entries(t).filter(([k]) => !["type", "quote", "timestamp", "id"].includes(k)),
    ),
  }));

  return SCORECARD_PROMPT_TEMPLATE.replace("{{move_log_json}}", () => JSON.stringify(moveLog ?? []))
    .replace("{{sub_scores_json}}", () => JSON.stringify(subScores))
    .replace("{{tells_json}}", () => JSON.stringify(tellsForPrompt));
}

// ---------------------------------------------------------------------------
// LLM client
// ---------------------------------------------------------------------------
// Defaults to AssemblyAI's LLM Gateway, which is OpenAI-compatible and uses the
// SAME ASSEMBLYAI_API_KEY -- so the whole app needs one key. Point LLM_BASE_URL /
// LLM_MODEL / LLM_API_KEY elsewhere to bring your own model.
// ---------------------------------------------------------------------------

function createLlmClient(env = process.env) {
  const apiKey = env.LLM_API_KEY || env.ASSEMBLYAI_API_KEY || "";
  const url = env.LLM_BASE_URL || "https://llm-gateway.assemblyai.com/v1/chat/completions";
  const model = env.LLM_MODEL || "qwen3.5-4b-32k-fast";
  const timeoutMs = Number(env.LLM_TIMEOUT_MS || 20000);

  return {
    isConfigured: () => Boolean(apiKey),
    model,
    async complete({ prompt }) {
      if (!apiKey) throw new Error("no_llm_api_key");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { authorization: apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1200,
            temperature: 0.4,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`llm_http_${res.status}: ${body.slice(0, 300)}`);
        }
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) throw new Error("llm_empty_response");
        return content;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Parsing + fallback narrative
// ---------------------------------------------------------------------------

/** Models sometimes wrap JSON in markdown fences despite instructions. */
function stripCodeFences(text) {
  let t = String(text || "").trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) t = fenced[1].trim();
  if (!t.startsWith("{")) {
    const first = t.indexOf("{");
    const last = t.lastIndexOf("}");
    if (first !== -1 && last > first) t = t.slice(first, last + 1);
  }
  return t;
}

function describeTell(tell) {
  switch (tell.type) {
    case "hesitation":
      return `You paused ${(tell.gapMs / 1000).toFixed(1)} seconds before saying "${tell.atWord}" — that reads as a bluffable number.`;
    case "retraction":
      return `You said $${Number(tell.from).toLocaleString("en-US")} and then walked it back to $${Number(tell.to).toLocaleString("en-US")} in the same breath — the moment you did that, the lower number became your real ask.`;
    case "pace_spike":
      return `You spoke about ${Math.round(((tell.wordsPerSecond - tell.baseline) / tell.baseline) * 100)}% faster than your own average here — rushing is what nerves sound like.`;
    case "mumbled_number":
      return `The number you named came through at ${Math.round(tell.numberConfidence * 100)}% confidence while the rest of the sentence was clear — you swallowed the figure instead of committing to it.`;
    default:
      return "A tell was detected in this utterance.";
  }
}

/** Fallback used when the LLM is unavailable or returns unparseable JSON twice. */
function buildFallbackNarrative({ moveLog, tellLog, subScores, finalScore }) {
  const moves = Array.isArray(moveLog) ? moveLog : [];

  const strongMoves = moves.filter(
    (m) => m.move_type === "anchor" || m.move_type === "counter_offer" || m.asked_for_reciprocity === true,
  );
  const wentWell = (strongMoves.length ? strongMoves : moves).slice(0, 3).map((m) => ({
    quote: m.quote,
    note:
      m.move_type === "anchor" || m.move_type === "counter_offer"
        ? "You named a specific number instead of waiting for them to move first."
        : m.asked_for_reciprocity
          ? "You tied your concession to something in return — that is how you keep leverage."
          : "You stayed in the conversation and kept the offer alive.",
  }));

  // Worst moment: the concession with no reciprocity asked and the largest drop.
  const nonReciprocal = moves.filter((m) => m.move_type === "concession" && m.asked_for_reciprocity === false);
  let biggestLoss = null;
  if (nonReciprocal.length) {
    const withNumbers = nonReciprocal.filter((m) => typeof m.number_mentioned === "number");
    const worst = (withNumbers.length ? withNumbers : nonReciprocal).reduce(
      (a, b) => ((b.number_mentioned ?? 0) < (a.number_mentioned ?? 0) ? b : a),
    );
    biggestLoss = {
      quote: worst.quote,
      note:
        typeof worst.number_mentioned === "number"
          ? `You dropped to $${worst.number_mentioned.toLocaleString("en-US")} without asking for anything back — that is leverage you never recover in the same conversation.`
          : "You conceded without asking for anything in return — that is leverage you never recover in the same conversation.",
    };
  }

  let nextTime = "Next time, name a specific number first and then stop talking — let them respond to your anchor instead of negotiating against yourself.";
  if (subScores.reciprocityRatio < 1) {
    nextTime = "When you give ground, name the trade in the same sentence: \"I can move on that if you can move on signing bonus.\" Never concede without a matching ask.";
  } else if (tellLog.length > 0) {
    nextTime = "When they go quiet after you name your number, count to five silently before speaking again — don't fill their silence with a lower offer.";
  } else if (subScores.finalOutcomeRatio !== null && subScores.finalOutcomeRatio < 1) {
    nextTime = "Open higher than your target next time — anchors move outcomes more than any other single move you make.";
  }

  return {
    went_well: wentWell,
    biggest_leverage_loss: biggestLoss,
    tells: (tellLog || []).map((t) => ({ type: t.type, quote: t.quote, note: describeTell(t) })),
    next_time_instruction: nextTime,
    narrative_source: "fallback",
    _finalScore: finalScore,
  };
}

/** Never let a malformed LLM payload reach the frontend. */
function normalizeScorecard(parsed, fallback) {
  const base = fallback;
  if (!parsed || typeof parsed !== "object") return base;

  const asString = (v) => (typeof v === "string" ? v.trim() : "");

  const wentWell = Array.isArray(parsed.went_well)
    ? parsed.went_well
        .filter((e) => e && (asString(e.quote) || asString(e.note)))
        .map((e) => ({ quote: asString(e.quote), note: asString(e.note) }))
    : [];

  const loss = parsed.biggest_leverage_loss;
  const biggestLoss =
    loss && typeof loss === "object" && (asString(loss.quote) || asString(loss.note))
      ? { quote: asString(loss.quote), note: asString(loss.note) }
      : null;

  const tells = Array.isArray(parsed.tells)
    ? parsed.tells
        .filter((t) => t && typeof t === "object")
        .map((t) => ({ type: asString(t.type) || "tell", quote: asString(t.quote), note: asString(t.note) }))
    : [];

  const instruction = asString(parsed.next_time_instruction);

  return {
    went_well: wentWell.length ? wentWell : base.went_well,
    biggest_leverage_loss: biggestLoss,
    tells: tells.length || !Array.isArray(parsed.tells) ? tells : base.tells,
    next_time_instruction: instruction || base.next_time_instruction,
    narrative_source: "llm",
  };
}

// ---------------------------------------------------------------------------
// Entry point (spec B.6)
// ---------------------------------------------------------------------------

async function scoreSession(sessionId, sessionStore, llmClient) {
  const moveLog = sessionStore.getMoves(sessionId);
  const tellLog = sessionStore.getTells(sessionId);
  const scenarioConfig = sessionStore.getScenarioConfig(sessionId);

  const subScores = computeSubScores(moveLog, tellLog, scenarioConfig);
  const finalScore = computeFinalScore(subScores, moveLog.length);

  const fallback = buildFallbackNarrative({ moveLog, tellLog, subScores, finalScore });

  // Empty-log case (spec part F): render a real scorecard rather than crashing.
  const payload = { moveLog, tellLog, subScores, finalScore };

  let narrative = null;
  let source = "fallback";

  if (llmClient && typeof llmClient.complete === "function" && (!llmClient.isConfigured || llmClient.isConfigured())) {
    const prompt = buildScorecardPrompt(payload);
    for (let attempt = 0; attempt < 2 && narrative === null; attempt++) {
      try {
        const raw = await llmClient.complete({
          prompt: attempt === 0 ? prompt : prompt + STRICTER_REMINDER,
        });
        const parsed = JSON.parse(stripCodeFences(raw));
        narrative = normalizeScorecard(parsed, fallback);
        source = "llm";
      } catch (err) {
        console.warn(
          `[scoreSession] LLM attempt ${attempt + 1} failed for ${sessionId}: ${err.message}`,
        );
      }
    }
  }

  const scorecard = narrative || fallback;
  delete scorecard._finalScore;

  // Always trust the deterministic score over whatever the LLM echoes back.
  scorecard.final_score = finalScore;
  scorecard.score_label = scoreLabelFor(finalScore);
  scorecard.narrative_source = source;
  scorecard.sub_scores = subScores;

  sessionStore.setScorecard(sessionId, scorecard);
  return scorecard;
}

module.exports = {
  scoreSession,
  computeSubScores,
  computeFinalScore,
  scoreLabelFor,
  buildScorecardPrompt,
  buildFallbackNarrative,
  createLlmClient,
  stripCodeFences,
  describeTell,
};
