/**
 * server.js
 *
 * Boots the HTTP server, mounts the REST routes, mounts the WebSocket server and
 * wires dependency injection between the session store, the voice agent session
 * and scoring.
 *
 * Spec: negotiation_dojo_full_spec.md section B.1 (REST) and B.8 (WS protocol)
 */

require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const { WebSocketServer, WebSocket } = require("ws");

const sessionStore = require("./store/sessionStore");
const { VoiceAgentSession } = require("./voiceAgentSession");
const { handleLogNegotiationMove } = require("./tools/logNegotiationMove");
const { detectTells, computeUtteranceStats } = require("./scoring/tellDetection");
const { scoreSession, createLlmClient } = require("./scoring/scoreSession");

// An empty or non-numeric PORT (some environments export PORT=0) would otherwise
// silently bind an ephemeral port and make the frontend fail to connect.
const parsedPort = Number.parseInt(process.env.PORT ?? "", 10);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8080;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

/** How long a session may sit with no browser attached before we stop billing. */
const IDLE_ABANDON_MS = 2 * 60 * 1000;
/** Cap on agent audio buffered while the browser is still connecting. */
const MAX_PENDING_AGENT_AUDIO = 600;

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

const llmClient = createLlmClient();

/** @type {Map<string, object>} runtime-only state, not persisted */
const runtimes = new Map();

// ---------------------------------------------------------------------------
// Scenario derivation (spec B.1)
// ---------------------------------------------------------------------------

function deriveScenarioNumbers(candidateTargetSalary) {
  return {
    aiOpeningOffer: Math.round(candidateTargetSalary * 0.85), // opens ~15% below target
    aiCeiling: Math.round(candidateTargetSalary * 1.10), // secretly can go 10% above target
  };
}

function humanReadableConnectionError(err) {
  const raw = String(err && err.message ? err.message : err);
  if (/UNAUTHORIZED/i.test(raw)) {
    return "AssemblyAI rejected the API key (UNAUTHORIZED). Check ASSEMBLYAI_API_KEY in backend/.env.";
  }
  if (/FORBIDDEN/i.test(raw)) {
    return "That AssemblyAI key is valid but lacks permission for the Voice Agent API (FORBIDDEN).";
  }
  if (/agent_timeout/i.test(raw)) {
    return "The voice agent did not come up in time. This is usually temporary — try again.";
  }
  if (/missing_api_key/i.test(raw)) {
    return "ASSEMBLYAI_API_KEY is not set on the backend. Copy backend/.env.example to backend/.env and add your key.";
  }
  if (/at_capacity|concurrency_exceeded|server_error|INTERNAL_ERROR/i.test(raw)) {
    return "AssemblyAI is temporarily at capacity. Try again in a moment.";
  }
  return `Could not start the voice session: ${raw}`;
}

// ---------------------------------------------------------------------------
// Session runtime
// ---------------------------------------------------------------------------

function createRuntime(sessionId, scenarioConfig) {
  const runtime = {
    sessionId,
    scenarioConfig,
    client: null,
    pendingAgentAudio: [],
    scorecard: null,
    scoringPromise: null,
    ended: false,
    idleTimer: null,
    voiceAgent: null,
  };

  const push = (message) => {
    if (runtime.client && runtime.client.readyState === WebSocket.OPEN) {
      runtime.client.send(JSON.stringify(message));
    }
  };

  const pushAgentAudio = (base64Chunk) => {
    if (runtime.client && runtime.client.readyState === WebSocket.OPEN) {
      runtime.client.send(JSON.stringify({ type: "agent_audio_chunk", payload: base64Chunk }));
    } else {
      // The greeting is spoken the moment the agent session is ready, which is
      // before the browser's WebSocket attaches. Buffer it so the opening offer
      // is not silently lost.
      runtime.pendingAgentAudio.push(base64Chunk);
      if (runtime.pendingAgentAudio.length > MAX_PENDING_AGENT_AUDIO) runtime.pendingAgentAudio.shift();
    }
  };

  runtime.voiceAgent = new VoiceAgentSession({
    sessionId,
    scenarioConfig,

    onTranscript: (transcript) => {
      if (transcript.source === "stt") {
        // Word-level leg: feeds tell detection only. It is deliberately NOT
        // forwarded as chat text, or every user turn would render twice.
        handleUserUtteranceForTells(runtime, transcript);
        return;
      }
      if (transcript.isFinal) {
        push({
          type: "transcript_final",
          speaker: transcript.speaker,
          text: transcript.text,
          ...(transcript.words && transcript.words.length ? { words: transcript.words } : {}),
        });
      } else {
        push({ type: "transcript_partial", speaker: transcript.speaker, text: transcript.text });
      }
    },

    onToolCall: ({ toolName, input }) => {
      if (toolName !== "log_negotiation_move") return;
      const move = handleLogNegotiationMove(sessionId, input, sessionStore);
      if (move) push({ type: "move_logged", move });
    },

    onAgentAudio: pushAgentAudio,

    onInterrupt: () => push({ type: "agent_audio_flush" }),

    onError: ({ code, message }) => push({ type: "error", code, message }),
  });

  runtimes.set(sessionId, runtime);
  return runtime;
}

/**
 * Runs on every FINAL user utterance that carries word-level data, i.e. every
 * final Turn from the streaming STT leg. The baseline is read BEFORE the current
 * utterance is folded into it, so an utterance is never compared against itself.
 */
function handleUserUtteranceForTells(runtime, transcript) {
  const { sessionId } = runtime;
  const words = transcript.words;
  if (!Array.isArray(words) || words.length === 0) return;

  const baseline = sessionStore.getBaseline(sessionId);
  const tells = detectTells(words, baseline);

  for (const tell of tells) {
    const stored = sessionStore.appendTell(sessionId, { ...tell, quote: tell.quote || transcript.text });
    const detail = Object.fromEntries(Object.entries(stored).filter(([k]) => !["type", "quote", "id", "timestamp"].includes(k)));
    if (runtime.client && runtime.client.readyState === WebSocket.OPEN) {
      runtime.client.send(JSON.stringify({ type: "tell_detected", tellType: stored.type, quote: stored.quote, detail }));
    }
  }

  sessionStore.updateBaseline(sessionId, computeUtteranceStats(words));
}

/**
 * Idempotent: the "End Session" button, the end_session WS message and the REST
 * endpoint can all land, and they must not produce two scorecards or two LLM calls.
 */
function finishSession(sessionId) {
  const runtime = runtimes.get(sessionId);
  if (!runtime) return Promise.resolve(sessionStore.getScorecard(sessionId));
  if (runtime.scorecard) return Promise.resolve(runtime.scorecard);
  if (runtime.scoringPromise) return runtime.scoringPromise;

  runtime.ended = true;
  if (runtime.idleTimer) clearTimeout(runtime.idleTimer);

  runtime.scoringPromise = (async () => {
    try {
      runtime.voiceAgent.endSession();
    } catch (err) {
      console.warn(`[server] error closing voice agent for ${sessionId}: ${err.message}`);
    }

    try {
      const scorecard = await scoreSession(sessionId, sessionStore, llmClient);
      runtime.scorecard = scorecard;
      if (runtime.client && runtime.client.readyState === WebSocket.OPEN) {
        runtime.client.send(JSON.stringify({ type: "scorecard_ready", scorecard }));
      }
      return scorecard;
    } catch (err) {
      // Allow a retry rather than caching the failure.
      runtime.scoringPromise = null;
      if (runtime.client && runtime.client.readyState === WebSocket.OPEN) {
        runtime.client.send(
          JSON.stringify({ type: "error", code: "SCORING_FAILED", message: `Scoring failed: ${err.message}` }),
        );
      }
      throw err;
    }
  })();

  return runtime.scoringPromise;
}

// ---------------------------------------------------------------------------
// REST endpoints (spec B.1)
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/session/start", async (req, res) => {
  const body = req.body || {};
  const targetSalary = Number(body.candidateTargetSalary);
  const walkaway = Number(body.candidateWalkaway);

  if (!Number.isFinite(targetSalary) || targetSalary <= 0) {
    return res.status(400).json({ error: "invalid_target_salary", message: "Target salary must be a positive number." });
  }
  if (!Number.isFinite(walkaway) || walkaway <= 0) {
    return res.status(400).json({ error: "invalid_walkaway", message: "Walk-away number must be a positive number." });
  }
  if (walkaway >= targetSalary) {
    return res.status(400).json({
      error: "walkaway_not_below_target",
      message: "Your walk-away number must be below your target salary.",
    });
  }

  const scenarioConfig = {
    candidateTargetSalary: targetSalary,
    candidateWalkaway: walkaway,
    companyName: (body.companyName || "").trim() || "Northbeam Analytics",
    roleTitle: (body.roleTitle || "").trim() || "Senior Software Engineer",
    ...deriveScenarioNumbers(targetSalary),
  };

  const sessionId = sessionStore.createSession(scenarioConfig);
  const runtime = createRuntime(sessionId, scenarioConfig);

  try {
    // Await the handshake so a bad key or a dead upstream surfaces on the setup
    // screen instead of transitioning the user into a silently broken live view.
    await runtime.voiceAgent.ready;
  } catch (err) {
    runtime.voiceAgent.endSession();
    runtimes.delete(sessionId);
    return res.status(502).json({
      error: "aai_connection_failed",
      message: humanReadableConnectionError(err),
    });
  }

  res.json({ sessionId, wsPath: `/ws/session/${sessionId}` });
});

app.post("/api/session/:id/end", async (req, res) => {
  const { id } = req.params;
  if (!sessionStore.getSession(id)) return res.status(404).json({ error: "unknown_session" });

  try {
    const scorecard = await finishSession(id);
    res.json({ scorecard });
  } catch (err) {
    res.status(500).json({ error: "scoring_failed", message: err.message });
  }
});

app.get("/api/session/:id/scorecard", (req, res) => {
  const scorecard = sessionStore.getScorecard(req.params.id);
  if (!scorecard) return res.status(404).json({ error: "not_ready" });
  res.json({ scorecard });
});

// ---------------------------------------------------------------------------
// WebSocket server (spec B.8)
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }

  const match = pathname.match(/^\/ws\/session\/([^/]+)$/);
  const runtime = match ? runtimes.get(match[1]) : null;

  if (!runtime) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => attachClient(runtime, ws));
});

function attachClient(runtime, ws) {
  // Only one browser tab drives a session; a reconnect replaces the old socket.
  if (runtime.client && runtime.client.readyState === WebSocket.OPEN) {
    try {
      runtime.client.close(1000, "replaced by a new connection");
    } catch {
      /* ignore */
    }
  }
  runtime.client = ws;
  if (runtime.idleTimer) {
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = null;
  }

  const send = (message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  send({ type: "session_ready", sessionId: runtime.sessionId });

  // Replay the greeting that was spoken before this socket existed.
  if (runtime.pendingAgentAudio.length) {
    for (const chunk of runtime.pendingAgentAudio.splice(0)) {
      send({ type: "agent_audio_chunk", payload: chunk });
    }
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send({ type: "error", code: "BAD_MESSAGE", message: "Malformed JSON message." });
    }

    switch (msg.type) {
      case "audio_chunk":
        runtime.voiceAgent.sendAudioChunk(msg.payload);
        break;

      case "end_session":
        finishSession(runtime.sessionId).catch((err) => {
          console.error(`[server] scoring failed for ${runtime.sessionId}: ${err.message}`);
        });
        break;

      default:
        send({ type: "error", code: "UNKNOWN_MESSAGE", message: `Unsupported message type: ${msg.type}` });
    }
  });

  ws.on("close", () => {
    if (runtime.client === ws) runtime.client = null;
    if (runtime.ended) return;

    // The browser walked away without ending the call. Stop the meter, but keep
    // everything already logged so scoring still works if they come back.
    runtime.idleTimer = setTimeout(() => {
      if (runtime.ended || runtime.client) return;
      console.log(`[server] session ${runtime.sessionId} abandoned; ending the voice agent to stop billing`);
      try {
        runtime.voiceAgent.endSession();
      } catch {
        /* ignore */
      }
    }, IDLE_ABANDON_MS);
  });

  ws.on("error", () => {
    /* handled by close */
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

sessionStore.loadFromDisk();

server.listen(PORT, () => {
  console.log(`Negotiation Dojo backend listening on http://localhost:${PORT}`);
  if (!process.env.ASSEMBLYAI_API_KEY) {
    console.warn("WARNING: ASSEMBLYAI_API_KEY is not set. Session start will fail until it is.");
  }
  console.log(`  LLM for scorecard narratives: ${llmClient.model} (${llmClient.isConfigured() ? "configured" : "NOT configured - using built-in narrative"})`);
});

function shutdown() {
  // Leave no billable sessions behind.
  for (const runtime of runtimes.values()) {
    try {
      runtime.voiceAgent.endSession();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { app, server, deriveScenarioNumbers, finishSession };
