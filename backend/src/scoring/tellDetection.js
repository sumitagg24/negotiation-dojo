/**
 * tellDetection.js
 *
 * Four pure detectors plus one orchestrator, run on every FINAL user utterance.
 * All timestamps are in milliseconds.
 *
 * Spec: negotiation_dojo_full_spec.md section B.5
 *
 * IMPLEMENTATION NOTE (detected against the live STT contract):
 * AssemblyAI returns *spoken* numbers, and a single spoken figure usually spans
 * several word tokens ("ninety five thousand" = 3 tokens). The spec's detectors
 * index a single token, which would compare "ninety" against "ninety" and never
 * fire. So `extractNumberMentions()` groups adjacent number tokens into one
 * figure and the detectors reason over those mentions. Function names,
 * signatures, thresholds and return shapes are otherwise exactly as specified.
 */

const THRESHOLDS = {
  /** Gap before a number that reads as hesitation. */
  hesitationGapMs: 1200,
  /** Speaking rate above baseline ratio that reads as a pace spike. */
  paceRatio: 1.4,
  /** Confidence drop below the utterance average that reads as "mumbled". */
  mumbleDrop: 0.15,
};

const UNIT_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS_WORDS = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const SCALE_WORDS = {
  hundred: 100,
  thousand: 1000,
  grand: 1000,
  million: 1000000,
  billion: 1000000000,
};

/** Tolerated *inside* a number group ("one hundred and twenty thousand"). */
const CONNECTOR_WORDS = new Set(["and", "a", "an"]);

const DIGIT_TOKEN_RE = /^(\d+(?:\.\d+)?)(k|m|bn|g)?$/;

function normalizeToken(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/^[^a-z0-9]+/i, "") // leading currency symbols, quotes, parens
    .replace(/[^a-z0-9]+$/i, "") // trailing punctuation
    .replace(/[,\-]/g, ""); // thousands separators, hyphenated compounds
}

/** "ninetyfive" -> 95, "twentythree" -> 23. Handles un-split compound tens. */
function compoundValue(token) {
  for (const tensWord of Object.keys(TENS_WORDS)) {
    if (token.length > tensWord.length && token.startsWith(tensWord)) {
      const rest = token.slice(tensWord.length);
      if (UNIT_WORDS[rest] !== undefined) return TENS_WORDS[tensWord] + UNIT_WORDS[rest];
    }
  }
  return null;
}

/** Matches digit strings, currency figures and spelled-out numbers. */
function isNumberToken(text) {
  const t = normalizeToken(text);
  if (!t) return false;
  if (DIGIT_TOKEN_RE.test(t)) return true;
  if (UNIT_WORDS[t] !== undefined) return true;
  if (TENS_WORDS[t] !== undefined) return true;
  if (SCALE_WORDS[t] !== undefined) return true;
  return compoundValue(t) !== null;
}

/** A number token's own value, ignoring any surrounding tokens. */
function parseSingleToken(token) {
  const t = normalizeToken(token);
  if (!t) return null;
  const digit = t.match(DIGIT_TOKEN_RE);
  if (digit) {
    const base = parseFloat(digit[1]);
    const suffix = digit[2];
    if (suffix === "k") return Math.round(base * 1000);
    if (suffix === "m") return Math.round(base * 1000000);
    if (suffix === "bn") return Math.round(base * 1000000000);
    if (suffix === "g") return Math.round(base * 1000000000);
    return Math.round(base);
  }
  if (UNIT_WORDS[t] !== undefined) return UNIT_WORDS[t];
  if (TENS_WORDS[t] !== undefined) return TENS_WORDS[t];
  if (SCALE_WORDS[t] !== undefined) return SCALE_WORDS[t];
  return compoundValue(t);
}

/**
 * Combine a run of number tokens into one figure.
 * "ninety five thousand" -> 95000, "92 thousand" -> 92000, "$92,000" -> 92000.
 */
function aggregateTokens(tokens) {
  let total = 0;
  let current = 0;
  let sawAny = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = normalizeToken(tokens[i]);
    if (!t) continue;

    if (CONNECTOR_WORDS.has(t)) {
      // "a hundred thousand" -> leading article means one
      const next = normalizeToken(tokens[i + 1] || "");
      if ((t === "a" || t === "an") && SCALE_WORDS[next] !== undefined) {
        current += 1;
        sawAny = true;
      }
      continue;
    }

    if (UNIT_WORDS[t] !== undefined) { current += UNIT_WORDS[t]; sawAny = true; continue; }
    if (TENS_WORDS[t] !== undefined) { current += TENS_WORDS[t]; sawAny = true; continue; }

    const compound = compoundValue(t);
    if (compound !== null) { current += compound; sawAny = true; continue; }

    if (SCALE_WORDS[t] !== undefined) {
      const scale = SCALE_WORDS[t];
      if (scale === 100) {
        current = (current || 1) * 100;
      } else {
        total += (current || 1) * scale;
        current = 0;
      }
      sawAny = true;
      continue;
    }

    const single = parseSingleToken(t);
    if (single !== null) { current = single; sawAny = true; continue; }

    return null; // an unparseable token means this is not a number run
  }

  if (!sawAny) return null;
  return total + current;
}

/** Normalizes any supported form to a plain integer, or null. */
function parseNumber(text) {
  if (text === null || text === undefined) return null;
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  if (tokens.length === 1) {
    const single = parseSingleToken(tokens[0]);
    return single === null ? null : single;
  }
  return aggregateTokens(tokens);
}

/** Joins word objects into a readable quote. */
function reconstructQuote(words) {
  return (Array.isArray(words) ? words : []).map((w) => w && w.text).filter(Boolean).join(" ");
}

function wordConfidence(word) {
  return typeof word?.confidence === "number" && Number.isFinite(word.confidence) ? word.confidence : 1;
}

/**
 * Finds every spoken figure in an utterance as a single mention, merging the
 * multiple word tokens a spoken number usually spans.
 *
 * @returns {Array<{text,value,startIdx,endIdx,start,end,confidence,avgConfidence}>}
 */
function extractNumberMentions(words) {
  const list = Array.isArray(words) ? words : [];
  const mentions = [];
  let i = 0;

  while (i < list.length) {
    if (!isNumberToken(list[i].text)) { i++; continue; }

    let j = i;
    while (j < list.length && (isNumberToken(list[j].text) || CONNECTOR_WORDS.has(normalizeToken(list[j].text)))) j++;
    // A run must not end on a connector ("...thousand and" belongs to nothing).
    while (j > i && CONNECTOR_WORDS.has(normalizeToken(list[j - 1].text))) j--;

    const group = list.slice(i, j);
    const value = aggregateTokens(group.map((w) => w.text));

    if (value !== null && group.length) {
      const confidences = group.map(wordConfidence);
      mentions.push({
        text: reconstructQuote(group),
        value,
        startIdx: i,
        endIdx: j - 1,
        start: group[0].start,
        end: group[group.length - 1].end,
        confidence: Math.min(...confidences),
        avgConfidence: confidences.reduce((s, c) => s + c, 0) / confidences.length,
      });
    }

    i = Math.max(j, i + 1);
  }

  return mentions;
}

// ---------------------------------------------------------------------------
// Detectors (spec B.5)
// ---------------------------------------------------------------------------

function detectHesitationBeforeNumber(words, options = {}) {
  const thresholdMs = options.hesitationGapMs ?? THRESHOLDS.hesitationGapMs;
  const list = Array.isArray(words) ? words : [];
  const mentions = extractNumberMentions(list);
  if (!mentions.length) return null;

  const mention = mentions[0];
  const numberIdx = mention.startIdx;
  if (numberIdx <= 0) return null;

  const gapMs = mention.start - list[numberIdx - 1].end;
  if (!Number.isFinite(gapMs) || gapMs <= thresholdMs) return null;

  return {
    type: "hesitation",
    gapMs,
    quote: reconstructQuote(list),
    atWord: mention.text,
  };
}

function detectRetraction(words) {
  const list = Array.isArray(words) ? words : [];
  const mentions = extractNumberMentions(list);
  if (mentions.length < 2) return null;

  const [first, second] = mentions;
  if (first.value === second.value) return null;

  return {
    type: "retraction",
    from: first.value,
    to: second.value,
    quote: reconstructQuote(list),
  };
}

function detectPaceSpike(words, sessionBaseline = {}) {
  const list = Array.isArray(words) ? words : [];
  if (list.length < 2) return null;

  const durationSec = (list[list.length - 1].end - list[0].start) / 1000;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;

  const wordsPerSecond = list.length / durationSec;
  const baseline = sessionBaseline.avgWordsPerSecond || 0;

  if (baseline > 0 && wordsPerSecond > baseline * THRESHOLDS.paceRatio) {
    return {
      type: "pace_spike",
      wordsPerSecond,
      baseline,
      quote: reconstructQuote(list),
    };
  }
  return null;
}

function detectMumbledNumber(words) {
  const list = Array.isArray(words) ? words : [];
  const mentions = extractNumberMentions(list);
  if (!mentions.length) return null;

  const avgConfidence = list.reduce((s, w) => s + wordConfidence(w), 0) / list.length;
  const numberConfidence = mentions[0].avgConfidence;

  if (avgConfidence - numberConfidence > THRESHOLDS.mumbleDrop) {
    return {
      type: "mumbled_number",
      numberConfidence,
      avgConfidence,
      quote: reconstructQuote(list),
    };
  }
  return null;
}

/**
 * Returns whichever tells fired, empty array if none.
 * Baseline must be read BEFORE the current utterance is folded into it.
 */
function detectTells(words, sessionBaseline = {}, options = {}) {
  return [
    detectHesitationBeforeNumber(words, options),
    detectRetraction(words),
    detectPaceSpike(words, sessionBaseline),
    detectMumbledNumber(words),
  ].filter(Boolean);
}

/** Per-utterance stats used to keep the session baseline current. */
function computeUtteranceStats(words) {
  const list = Array.isArray(words) ? words : [];
  if (!list.length) return { wordsPerSecond: 0, confidence: 0 };

  const confidence = list.reduce((s, w) => s + wordConfidence(w), 0) / list.length;
  const durationSec = (list[list.length - 1].end - list[0].start) / 1000;
  const wordsPerSecond = durationSec > 0 ? list.length / durationSec : 0;

  return { wordsPerSecond, confidence };
}

module.exports = {
  THRESHOLDS,
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
};
