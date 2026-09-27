/**
 * Full-stack integration test.
 *
 * Boots the REAL server.js (REST + WebSocket) and points both AssemblyAI legs and
 * the LLM endpoint at a mock. Then drives the whole product flow over the actual
 * network surfaces:
 *
 *   POST /api/session/start
 *     -> WebSocket session_ready
 *     -> mock tool.call          -> move_logged
 *     -> mock STT Turn w/ words  -> tell_detected
 *     -> mock transcript.user    -> transcript_final
 *     -> end_session             -> scorecard_ready
 *   GET /api/session/:id/scorecard
 *
 * This is the closest thing to a live run that does not need an API key.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const os = require("os");
const path = require("path");
const { once } = require("node:events");

const { WebSocketServer, WebSocket } = require("ws");

const PORT = 8137;
const BASE = `http://127.0.0.1:${PORT}`;

/** The narrative the mock LLM returns. It deliberately invents a score. */
const MOCK_NARRATIVE = JSON.stringify({
  final_score: 999,
  score_label: "Legendary",
  went_well: [{ quote: "I'd like $110,000.", note: "Clear anchor with no apology." }],
  biggest_leverage_loss: { quote: "Okay, I could do $95,000.", note: "You dropped $15k with nothing asked back." },
  tells: [{ type: "hesitation", quote: "around ninety five thousand", note: "You paused 1.5s before the number." }],
  next_time_instruction: "When they go quiet, count to five before speaking.",
});

function waitFor(list, predicate, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = list.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timed out waiting for ${label}. Received: ${JSON.stringify(list)}`));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/llm" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          // No keep-alive: undici's connection pool would otherwise hold the
          // mock's HTTP server open and stop it from ever closing.
          res.writeHead(200, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: MOCK_NARRATIVE } }] }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const wss = new WebSocketServer({ server });
    const connections = [];

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const conn = { ws, path: url.pathname, search: url.search, received: [] };
      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        try {
          conn.received.push(JSON.parse(raw.toString()));
        } catch {
          /* ignore */
        }
      });
      conn.send = (payload) => ws.send(JSON.stringify(payload));
      connections.push(conn);

      if (url.pathname === "/agent") {
        setTimeout(() => conn.send({ type: "session.ready", session_id: "sess_mock" }), 5);
      } else {
        conn.send({ type: "Begin", id: "stt_mock" });
      }
    });

    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        agent: () => connections.find((c) => c.path === "/agent"),
        stt: () => connections.find((c) => c.path === "/stt"),
        close: () =>
          new Promise((done) => {
            for (const conn of connections) {
              try {
                conn.ws.terminate();
              } catch {
                /* ignore */
              }
            }
            if (typeof server.closeAllConnections === "function") server.closeAllConnections();
            const timer = setTimeout(done, 1000);
            wss.close(() =>
              server.close(() => {
                clearTimeout(timer);
                done();
              }),
            );
          }),
      }),
    );
  });
}

/**
 * Closing an HTTP server waits for every open connection to end, and an upgraded
 * WebSocket connection never ends on its own -- so both are torn down explicitly
 * with a hard timeout as a backstop.
 */
async function teardown(server, mock, client) {
  try {
    client?.close();
  } catch {
    /* ignore */
  }
  await mock.close();
  for (const conn of server.__testConnections || []) {
    try {
      conn.terminate();
    } catch {
      /* ignore */
    }
  }
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise((done) => {
    const timer = setTimeout(done, 800);
    server.close(() => {
      clearTimeout(timer);
      done();
    });
  });
}

test("full stack: start, capture a move and a tell, then score the session", async (t) => {
  const mock = await startMock();

  // Point the real server at the mock. dotenv never overrides values that are
  // already present in process.env, so these win over any local .env file.
  process.env.PORT = String(PORT);
  process.env.ASSEMBLYAI_API_KEY = "test-key";
  process.env.ASSEMBLYAI_AGENT_WS_URL = `ws://127.0.0.1:${mock.port}/agent`;
  process.env.ASSEMBLYAI_STREAMING_WS_URL = `ws://127.0.0.1:${mock.port}/stt`;
  process.env.LLM_BASE_URL = `http://127.0.0.1:${mock.port}/llm`;
  process.env.LLM_MODEL = "mock-model";
  process.env.SESSION_STORE_PATH = path.join(os.tmpdir(), `nd-fullstack-${process.pid}.json`);

  let server;
  try {
    ({ server } = require("../src/server"));
    if (!server.listening) await once(server, "listening");
  } catch (err) {
    await mock.close();
    throw new Error(`could not boot the server on port ${PORT}: ${err.message}`);
  }

  // ---------------------------------------------------------------- start
  const startRes = await fetch(`${BASE}/api/session/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidateTargetSalary: 100000, candidateWalkaway: 90000 }),
  });
  assert.equal(startRes.status, 200, "start should succeed against the mock");

  const { sessionId, wsPath } = await startRes.json();
  assert.ok(sessionId);
  assert.equal(wsPath, `/ws/session/${sessionId}`);

  // ------------------------------------------------------------ websocket
  const messages = [];
  const client = new WebSocket(`ws://127.0.0.1:${PORT}${wsPath}`);
  client.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await once(client, "open");

  t.after(() => teardown(server, mock, client));

  const ready = await waitFor(messages, (m) => m.type === "session_ready", "session_ready");
  assert.equal(ready.sessionId, sessionId);

  // Audio flows through to both legs.
  client.send(JSON.stringify({ type: "audio_chunk", payload: Buffer.alloc(2400, 7).toString("base64") }));
  await wait(60);
  assert.ok(
    mock.agent().received.some((m) => m.type === "input.audio"),
    "the browser's audio should reach the voice agent leg",
  );

  // ------------------------------------------------------- move logging
  mock.agent().send({
    type: "tool.call",
    call_id: "c1",
    name: "log_negotiation_move",
    arguments: {
      move_type: "anchor",
      quote: "I'd like to start around $110,000, given the scope of the role.",
      number_mentioned: 110000,
      asked_for_reciprocity: false,
      rationale: "Candidate named a number first.",
    },
  });
  mock.agent().send({ type: "reply.done", reply_id: "r1", status: "completed" });

  const anchor = await waitFor(messages, (m) => m.type === "move_logged", "first move_logged");
  assert.equal(anchor.move.move_type, "anchor");
  assert.equal(anchor.move.number_mentioned, 110000);
  assert.ok(anchor.move.id, "moves are stamped with an id");
  assert.ok(typeof anchor.move.timestamp === "number");

  // A concession with nothing asked back: this must become the leverage loss.
  mock.agent().send({
    type: "tool.call",
    call_id: "c2",
    name: "log_negotiation_move",
    arguments: {
      move_type: "concession",
      quote: "Okay, I could probably do $95,000.",
      number_mentioned: 95000,
      asked_for_reciprocity: false,
      rationale: "Candidate conceded without asking for anything.",
    },
  });
  mock.agent().send({ type: "reply.done", reply_id: "r2", status: "completed" });
  await waitFor(messages, (m) => m.type === "move_logged" && m.move.number_mentioned === 95000, "concession");

  // ------------------------------------------------------- transcript
  mock.agent().send({ type: "transcript.user.delta", text: "I was thinking around" });
  mock.agent().send({ type: "transcript.user", text: "I was thinking around ninety thousand." });
  await waitFor(messages, (m) => m.type === "transcript_final" && m.speaker === "user", "user transcript_final");

  // ---------------------------------------------------- tell detection
  // 1500ms of silence before the figure, delivered on the word-level leg.
  mock.stt().send({
    type: "Turn",
    turn_order: 0,
    end_of_turn: true,
    transcript: "I was thinking around ninety five thousand.",
    words: [
      { text: "I", start: 0, end: 100, confidence: 0.99 },
      { text: "was", start: 100, end: 250, confidence: 0.99 },
      { text: "thinking", start: 250, end: 600, confidence: 0.99 },
      { text: "around", start: 600, end: 900, confidence: 0.99 },
      { text: "ninety", start: 2400, end: 2700, confidence: 0.99 },
      { text: "five", start: 2700, end: 2900, confidence: 0.99 },
      { text: "thousand", start: 2900, end: 3400, confidence: 0.99 },
    ],
  });

  const tell = await waitFor(messages, (m) => m.type === "tell_detected", "tell_detected");
  assert.equal(tell.tellType, "hesitation");
  assert.equal(tell.detail.gapMs, 1500);
  // reconstructQuote (spec B.5) rebuilds the quote from the word tokens, so it
  // carries the spoken words without the transcript's terminal punctuation.
  assert.equal(tell.quote, "I was thinking around ninety five thousand");

  // The word-level leg must NOT leak into the chat transcript a second time.
  assert.equal(
    messages.filter((m) => m.type === "transcript_final" && m.speaker === "user").length,
    1,
    "the user's turn should be rendered once, from the agent leg only",
  );

  // ----------------------------------------------------------- scoring
  client.send(JSON.stringify({ type: "end_session" }));

  const scored = await waitFor(messages, (m) => m.type === "scorecard_ready", "scorecard_ready", 10000);
  const scorecard = scored.scorecard;

  // anchorQuality 1.0, reciprocityRatio 0, tellDensity 0.5, ratio 95000/100000
  // 0.30 + 0 + 0.25*0.5 + 0.15*(0.95/1.15) == 0.5489 -> 55
  assert.equal(scorecard.final_score, 55, "the deterministic formula decides the score");
  assert.equal(scorecard.score_label, "Solid, room to grow");
  assert.equal(scorecard.narrative_source, "llm", "the mock LLM narrative should be used");
  assert.equal(scorecard.sub_scores.reciprocityRatio, 0);
  assert.equal(scorecard.sub_scores.tellDensity, 0.5);
  assert.equal(scorecard.sub_scores.anchorQuality, 1);

  // The LLM claimed 999 and "Legendary"; neither may survive.
  assert.notEqual(scorecard.final_score, 999, "an LLM-invented score must be discarded");
  assert.notEqual(scorecard.score_label, "Legendary");

  // Prose comes from the LLM.
  assert.equal(scorecard.went_well[0].note, "Clear anchor with no apology.");
  assert.equal(scorecard.biggest_leverage_loss.quote, "Okay, I could do $95,000.");
  assert.equal(scorecard.biggest_leverage_loss.note, "You dropped $15k with nothing asked back.");

  // ------------------------------------------------------ REST retrieval
  const cardRes = await fetch(`${BASE}/api/session/${sessionId}/scorecard`);
  assert.equal(cardRes.status, 200);
  const cardBody = await cardRes.json();
  assert.equal(cardBody.scorecard.final_score, 55);

  // -------------------------------------------------------------- teardown
  // The voice agent must have been told to end, or it keeps billing.
  await wait(120);
  assert.ok(
    mock.agent().received.some((m) => m.type === "session.end"),
    "ending the session must send session.end upstream",
  );

  // --------------------------------------------- unknown sessions rejected
  const unknownEnd = await fetch(`${BASE}/api/session/does-not-exist/end`, { method: "POST" });
  assert.equal(unknownEnd.status, 404);

  // A WebSocket upgrade for an unknown session must be refused outright rather
  // than left dangling.
  const bogus = new WebSocket(`ws://127.0.0.1:${PORT}/ws/session/does-not-exist`);
  const outcome = await new Promise((resolve) => {
    bogus.on("open", () => resolve("opened"));
    bogus.on("error", () => resolve("rejected"));
    bogus.on("close", () => resolve("closed"));
    setTimeout(() => resolve("hung"), 2000);
  });
  assert.notEqual(outcome, "opened", "an unknown session must not get a live socket");
  assert.notEqual(outcome, "hung", "the socket should be refused, not left dangling");
});
