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
const {
  startKeepAlive,
  stopKeepAlive,
  getKeepAliveStatus,
  triggerKeepAlivePing,
} = require("./cron/keepAlive");

// An empty or non-numeric PORT (some environments export PORT=0) would otherwise
// silently bind an ephemeral port and make the frontend fail to connect.
const parsedPort = Number.parseInt(process.env.PORT ?? "", 10);
const PORT = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8080;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

/**
 * CORS_ORIGIN accepts a COMMA-SEPARATED list, because one frontend is served from
 * several hosts at once: local dev, the production Vercel alias, its per-branch
 * alias, and a brand new unique URL for every preview deployment. A single string
 * silently breaks all but one of them, and the browser reports it as a generic
 * network failure rather than a CORS rejection.
 *
 * Each entry is an exact origin ("https://app.vercel.app") or a wildcard subdomain
 * pattern ("https://*.vercel.app"). Use "*" to allow everything.
 */
function buildOriginMatcher(raw) {
  const entries = String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const exact = new Set();
  const wildcards = [];
  let allowAll = false;

  for (const entry of entries) {
    if (entry === "*") {
      allowAll = true;
      continue;
    }
    const wildcard = entry.match(/^(https?:\/\/)\*\.(.+)$/);
    if (wildcard) wildcards.push({ scheme: wildcard[1], suffix: wildcard[2] });
    else exact.add(entry.replace(/\/+$/, ""));
  }

  return {
    allowed: entries,
    test(origin) {
      if (!origin) return true; // curl, Render health checks, same-origin requests
      if (allowAll) return true;
      const cleanOrigin = origin.replace(/\/+$/, "");
      if (exact.has(cleanOrigin)) return true;
      return wildcards.some(({ scheme, suffix }) => {
        if (!cleanOrigin.startsWith(scheme)) return false;
        const host = cleanOrigin.slice(scheme.length);
        return host === suffix || host.endsWith(`.${suffix}`);
      });
    },
  };
}

const originMatcher = buildOriginMatcher(CORS_ORIGIN);

/** How long a session may sit with no browser attached before we stop billing. */
const IDLE_ABANDON_MS = 2 * 60 * 1000;
/** Cap on agent audio buffered while the browser is still connecting. */
const MAX_PENDING_AGENT_AUDIO = 600;
/** Heartbeat interval to prevent Render proxy from dropping idle WebSockets (Render drops at 100s) */
const WS_HEARTBEAT_INTERVAL_MS = 30000;

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      if (originMatcher.test(origin)) return callback(null, true);
      // Deny by omitting the CORS headers (the browser surfaces a normal CORS
      // error) but log the precise cause, because the allowed list is the fix.
      console.warn(
        `[cors] blocked origin "${origin}". CORS_ORIGIN allows: ${originMatcher.allowed.join(", ")}`,
      );
      callback(null, false);
    },
  }),
);
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

  // If browser starts session but abandons before attaching WebSocket, stop billing
  runtime.idleTimer = setTimeout(() => {
    if (runtime.ended || runtime.client) return;
    console.log(`[server] session ${sessionId} never attached; ending voice agent`);
    try {
      runtime.voiceAgent?.endSession();
    } catch {
      /* ignore */
    }
  }, IDLE_ABANDON_MS);

  const push = (message) => {
    if (runtime.client && runtime.client.readyState === WebSocket.OPEN) {
      try {
        runtime.client.send(JSON.stringify(message));
      } catch (err) {
        console.warn(`[server ${sessionId}] ws push error: ${err.message}`);
      }
    }
  };

  const pushAgentAudio = (base64Chunk) => {
    if (runtime.client && runtime.client.readyState === WebSocket.OPEN) {
      try {
        runtime.client.send(JSON.stringify({ type: "agent_audio_chunk", payload: base64Chunk }));
      } catch (err) {
        console.warn(`[server ${sessionId}] ws audio push error: ${err.message}`);
      }
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
      try {
        runtime.client.send(JSON.stringify({ type: "tell_detected", tellType: stored.type, quote: stored.quote, detail }));
      } catch {
        /* ignore */
      }
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
  if (!runtime) {
    const existing = sessionStore.getScorecard(sessionId);
    if (existing) return Promise.resolve(existing);
    if (sessionStore.getSession(sessionId)) {
      return scoreSession(sessionId, sessionStore, llmClient);
    }
    return Promise.resolve(null);
  }
  if (runtime.scorecard) return Promise.resolve(runtime.scorecard);
  if (runtime.scoringPromise) return runtime.scoringPromise;

  runtime.ended = true;
  if (runtime.idleTimer) {
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = null;
  }

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
        try {
          runtime.client.send(JSON.stringify({ type: "scorecard_ready", scorecard }));
        } catch {
          /* ignore */
        }
      }
      return scorecard;
    } catch (err) {
      // Allow a retry rather than caching the failure.
      runtime.scoringPromise = null;
      if (runtime.client && runtime.client.readyState === WebSocket.OPEN) {
        try {
          runtime.client.send(
            JSON.stringify({ type: "error", code: "SCORING_FAILED", message: `Scoring failed: ${err.message}` }),
          );
        } catch {
          /* ignore */
        }
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
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime() * 10) / 10,
    timestamp: new Date().toISOString(),
    keepAlive: getKeepAliveStatus(),
    activeSessions: runtimes.size,
  });
});

app.post("/api/keep-alive/ping", async (_req, res) => {
  const result = await triggerKeepAlivePing({ isRetry: false });
  res.json(result);
});

app.get("/api/keep-alive", (_req, res) => {
  res.json(getKeepAliveStatus());
});

app.post("/api/session/start", async (req, res, next) => {
  try {
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
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
      runtimes.delete(sessionId);
      return res.status(502).json({
        error: "aai_connection_failed",
        message: humanReadableConnectionError(err),
      });
    }

    res.json({ sessionId, wsPath: `/ws/session/${sessionId}` });
  } catch (err) {
    next(err);
  }
});

app.post("/api/session/:id/end", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!sessionStore.getSession(id)) return res.status(404).json({ error: "unknown_session" });

    const scorecard = await finishSession(id);
    if (!scorecard) {
      return res.status(500).json({ error: "scoring_failed", message: "Scorecard could not be generated." });
    }
    res.json({ scorecard });
  } catch (err) {
    next(err);
  }
});


app.get("/api/session/:id/scorecard", (req, res) => {
  const scorecard = sessionStore.getScorecard(req.params.id);
  if (!scorecard) return res.status(404).json({ error: "not_ready" });
  res.json({ scorecard });
});

// Express error handling middleware
app.use((err, _req, res, _next) => {
  console.error("[server] Unhandled request error:", err);
  if (res.headersSent) return;
  res.status(500).json({
    error: "internal_server_error",
    message: err.message || "An unexpected error occurred.",
  });
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
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
    // pong from frontend resets the 3-cycle miss counter (already done by messages,
    // but RFC 6455 pong fires separately)
    ws.missedPings = 0;
  });

  if (runtime.idleTimer) {
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = null;
  }

  const send = (message) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        /* ignore */
      }
    }
  };

  send({ type: "session_ready", sessionId: runtime.sessionId });

  // Replay the greeting that was spoken before this socket existed.
  if (runtime.pendingAgentAudio.length) {
    for (const chunk of runtime.pendingAgentAudio.splice(0)) {
      send({ type: "agent_audio_chunk", payload: chunk });
    }
  }

  ws.on("message", (raw) => {
    ws.isAlive = true;
    ws.missedPings = 0;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send({ type: "error", code: "BAD_MESSAGE", message: "Malformed JSON message." });
    }

    switch (msg.type) {
      case "ping":
        return send({ type: "pong", timestamp: Date.now() });

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

  ws.on("close", (code, reason) => {
    const reasonStr = reason ? reason.toString() : "(no reason)";
    console.log(`[diag:fe-close ${runtime.sessionId}] browser WS closed: code=${code} reason=${reasonStr} sessionEnded=${runtime.ended} @ ${new Date().toISOString()}`);
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

  ws.on("error", (err) => {
    console.warn(`[diag:fe-error ${runtime.sessionId}] browser WS error: ${err.message} @ ${new Date().toISOString()}`);
    /* handled by close */
  });
}

// Keep-alive heartbeat across all active WebSocket connections (prevents Render proxy 100s drop)
const wsHeartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.missedPings = (ws.missedPings || 0) + 1;
      if (ws.missedPings >= 3) {
        console.log(`[diag:heartbeat] terminating browser WS after 3 missed ping cycles (no pong/message) @ ${new Date().toISOString()}`);
        return ws.terminate();
      }
      console.log(`[diag:heartbeat] browser WS missed ping #${ws.missedPings} (isAlive=false) @ ${new Date().toISOString()}`);
    } else {
      ws.missedPings = 0;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  });
}, WS_HEARTBEAT_INTERVAL_MS);

if (typeof wsHeartbeatInterval.unref === "function") {
  wsHeartbeatInterval.unref();
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
  console.log(
    `  LLM for scorecard narratives: ${llmClient.model} (${llmClient.isConfigured() ? "configured" : "NOT configured - using built-in narrative"})`,
  );
  startKeepAlive();
});

function shutdown() {
  console.log("[server] Shutting down gracefully...");
  if (wsHeartbeatInterval) clearInterval(wsHeartbeatInterval);
  stopKeepAlive();

  // Leave no billable sessions behind.
  for (const runtime of runtimes.values()) {
    if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
    try {
      runtime.voiceAgent?.endSession();
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled Promise Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[process] Uncaught Exception:", err);
});

module.exports = { app, server, deriveScenarioNumbers, finishSession };
