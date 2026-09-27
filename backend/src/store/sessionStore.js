/**
 * sessionStore.js
 *
 * In-memory `Map<sessionId, SessionState>`, mirrored to a JSON file after every
 * write so a server crash mid-demo does not lose a session.
 *
 * Spec: negotiation_dojo_full_spec.md section B.7
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** @type {Map<string, object>} */
const sessions = new Map();

const STORE_PATH = process.env.SESSION_STORE_PATH || "./data/sessions.json";
let persistInFlight = false;

let persistPending = false;

function generateId(prefix = "") {
  const id = crypto.randomBytes(8).toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Async, non-blocking mirror to disk. Deliberately not debounced: the whole
 * point of this file is that the most recent write survives a crash.
 * If a write is already in flight, flag a pending write so rapid sequential writes
 * (e.g. moves and tells occurring close together) are never silently dropped.
 */
function persist() {
  if (persistInFlight) {
    persistPending = true;
    return;
  }
  persistInFlight = true;
  persistPending = false;
  const payload = JSON.stringify({ sessions: Array.from(sessions.entries()) }, null, 0);
  const dir = path.dirname(STORE_PATH);

  fs.mkdir(dir, { recursive: true }, (mkdirErr) => {
    if (mkdirErr) {
      persistInFlight = false;
      console.error("[sessionStore] mkdir failed:", mkdirErr.message);
      if (persistPending) persist();
      return;
    }
    fs.writeFile(STORE_PATH, payload, (err) => {
      persistInFlight = false;
      if (err) console.error("[sessionStore] persist failed:", err.message);
      if (persistPending) persist();
    });
  });
}

/** Restore sessions from the fallback file on boot (best effort). */
function loadFromDisk() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw);
    for (const [id, state] of parsed.sessions || []) sessions.set(id, state);
    console.log(`[sessionStore] restored ${sessions.size} session(s) from ${STORE_PATH}`);
  } catch (err) {
    console.warn(`[sessionStore] could not restore from ${STORE_PATH}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API (spec B.7)
// ---------------------------------------------------------------------------

function createSession(config) {
  const sessionId = generateId("sess");
  const now = Date.now();
  sessions.set(sessionId, {
    sessionId,
    scenarioConfig: config,
    moves: [],
    tells: [],
    baseline: { avgWordsPerSecond: 0, avgConfidence: 0, utteranceCount: 0 },
    scorecard: null,
    createdAt: now,
    updatedAt: now,
  });
  persist();
  return sessionId;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function touch(session) {
  session.updatedAt = Date.now();
}

function appendMove(sessionId, move) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.moves.push(move);
  touch(session);
  persist();
  return move;
}

function appendTell(sessionId, tell) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  // Every tell is stamped with the wall-clock time it was observed, so the
  // scorecard can interleave tells with moves on a single timeline.
  const stamped = { ...tell, id: tell.id || generateId("tell"), timestamp: tell.timestamp || Date.now() };
  session.tells.push(stamped);
  touch(session);
  persist();
  return stamped;
}

/**
 * Fold one utterance's stats into the running per-session baseline. Later
 * utterances are always compared against the user's OWN established baseline,
 * never a fixed constant.
 */
function updateBaseline(sessionId, utteranceStats) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const { wordsPerSecond, confidence } = utteranceStats;
  const b = session.baseline;
  const n = b.utteranceCount;

  if (typeof wordsPerSecond === "number" && Number.isFinite(wordsPerSecond)) {
    b.avgWordsPerSecond = (b.avgWordsPerSecond * n + wordsPerSecond) / (n + 1);
  }
  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    b.avgConfidence = n === 0 ? confidence : (b.avgConfidence * n + confidence) / (n + 1);
  }
  b.utteranceCount = n + 1;

  touch(session);
  persist();
  return b;
}

function getMoves(sessionId) {
  const session = sessions.get(sessionId);
  return session ? session.moves : [];
}

function getTells(sessionId) {
  const session = sessions.get(sessionId);
  return session ? session.tells : [];
}

function getScenarioConfig(sessionId) {
  const session = sessions.get(sessionId);
  return session ? session.scenarioConfig : null;
}

function getBaseline(sessionId) {
  const session = sessions.get(sessionId);
  return session ? session.baseline : { avgWordsPerSecond: 0, avgConfidence: 0, utteranceCount: 0 };
}

function setScorecard(sessionId, scorecard) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.scorecard = scorecard;
  touch(session);
  persist();
  return scorecard;
}

function getScorecard(sessionId) {
  const session = sessions.get(sessionId);
  return session ? session.scorecard : null;
}

module.exports = {
  generateId,
  loadFromDisk,
  createSession,
  getSession,
  appendMove,
  appendTell,
  updateBaseline,
  getMoves,
  getTells,
  getScenarioConfig,
  getBaseline,
  setScorecard,
  getScorecard,
};
