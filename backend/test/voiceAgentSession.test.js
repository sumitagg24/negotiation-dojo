/**
 * Integration tests for voiceAgentSession.js against a mock AssemblyAI server.
 *
 * This is the end-to-end contract verification that does not need a live API key:
 * it proves the handshake, the transcript mapping, the tool-call round trip, the
 * barge-in flush and - most importantly - that final user turns carrying word
 * timings reach the caller, which is the whole basis of tell detection.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const { WebSocketServer } = require("ws");

/** A fake AssemblyAI: one path speaks Voice Agent, the other speaks Streaming STT. */
function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const connections = [];

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const conn = { ws, path: url.pathname, search: url.search, headers: req.headers, received: [], binary: [] };

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          conn.binary.push(Buffer.from(raw));
          return;
        }
        try {
          conn.received.push(JSON.parse(raw.toString()));
        } catch {
          conn.received.push(raw.toString());
        }
      });

      connections.push(conn);

      // Voice Agent handshake completes asynchronously, as the real API does.
      if (url.pathname === "/agent") {
        setTimeout(() => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "session.ready", session_id: "sess_mock_123" }));
          }
        }, 5);
      } else {
        ws.send(JSON.stringify({ type: "Begin", id: "stt_mock", expires_at: 0 }));
      }

      conn.send = (payload) => ws.send(JSON.stringify(payload));
      conn.close = () => ws.close();
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        connections,
        agentConnection: () => connections.find((c) => c.path === "/agent"),
        sttConnection: () => connections.find((c) => c.path !== "/agent"),
        close: () =>
          new Promise((done) => {
            for (const conn of connections) {
              try {
                conn.ws.terminate();
              } catch {
                /* ignore */
              }
            }
            wss.close(() => server.close(done));
          }),
      });
    });
  });
}

async function withSession(options, run) {
  const { VoiceAgentSession } = require("../src/voiceAgentSession");
  const mock = await startMock();

  process.env.ASSEMBLYAI_API_KEY = "test-key";
  process.env.ASSEMBLYAI_AGENT_WS_URL = `ws://127.0.0.1:${mock.port}/agent`;
  process.env.ASSEMBLYAI_STREAMING_WS_URL = `ws://127.0.0.1:${mock.port}/stt`;

  const events = { transcripts: [], toolCalls: [], audio: [], errors: [], interrupts: 0 };

  const session = new VoiceAgentSession({
    sessionId: "s_test",
    scenarioConfig: {
      candidateTargetSalary: 100000,
      candidateWalkaway: 90000,
      companyName: "Northbeam Analytics",
      roleTitle: "Senior Software Engineer",
      aiOpeningOffer: 85000,
      aiCeiling: 110000,
    },
    onTranscript: (t) => events.transcripts.push(t),
    onToolCall: (t) => events.toolCalls.push(t),
    onAgentAudio: (chunk) => events.audio.push(chunk),
    onInterrupt: () => {
      events.interrupts += 1;
    },
    onError: (e) => events.errors.push(e),
    ...options,
  });

  try {
    await session.ready;
    await new Promise((r) => setTimeout(r, 30)); // let the STT leg settle
    await run({ session, mock, events });
  } finally {
    session.endSession();
    await new Promise((r) => setTimeout(r, 60));
    await mock.close();
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

test("sends the persona prompt, greeting and tool definition on connect", async () => {
  await withSession({}, async ({ mock }) => {
    const conn = mock.agentConnection();
    assert.ok(conn, "should have opened the Voice Agent connection");
    assert.equal(conn.headers.authorization, "Bearer test-key");

    const update = conn.received.find((m) => m.type === "session.update");
    assert.ok(update, "should send session.update first");

    const { session } = update;
    assert.match(session.system_prompt, /You are Alex Chen, Senior Engineering Manager at Northbeam Analytics/);
    assert.match(session.system_prompt, /\$110000/, "the secret ceiling is interpolated");
    assert.match(session.system_prompt, /\n/);
    assert.match(session.greeting, /\$85000/, "the greeting carries the opening offer");

    // The candidate's private numbers must never reach the persona prompt.
    assert.ok(
      !session.system_prompt.includes("candidateWalkaway") && !session.system_prompt.includes("90000"),
      "the walk-away number must not leak into Alex's prompt",
    );

    assert.equal(session.input.format.encoding, "audio/pcm");
    assert.equal(session.output.format.encoding, "audio/pcm");

    const tool = session.tools[0];
    assert.equal(tool.type, "function");
    assert.equal(tool.name, "log_negotiation_move");
    assert.equal(tool.execution_mode, "interactive", "a hold-mode tool would stall every turn");
    assert.ok(tool.parameters.properties.move_type.enum.includes("counter_offer"));
    assert.deepEqual(tool.parameters.required, ["move_type", "quote", "rationale"]);
  });
});

test("maps transcript and audio events onto the callback contract", async () => {
  await withSession({}, async ({ mock, events }) => {
    const conn = mock.agentConnection();

    conn.send({ type: "transcript.user.delta", text: "I was thinking around ninety" });
    await wait(25);
    conn.send({ type: "transcript.user", text: "I was thinking around ninety five thousand." });
    await wait(25);
    conn.send({ type: "reply.audio", data: "QUJD" });
    await wait(25);
    conn.send({ type: "transcript.agent", text: "That's outside our band right now.", reply_id: "r1" });
    await wait(40);

    const userPartial = events.transcripts.find((t) => t.speaker === "user" && !t.isFinal);
    assert.ok(userPartial, "partial user transcript should be forwarded");
    assert.equal(userPartial.text, "I was thinking around ninety");
    assert.equal(userPartial.source, "agent");

    const userFinal = events.transcripts.find((t) => t.speaker === "user" && t.isFinal);
    assert.equal(userFinal.text, "I was thinking around ninety five thousand.");
    // The Voice Agent API has no word timings, so words is empty here.
    assert.deepEqual(userFinal.words, []);

    const agentFinal = events.transcripts.find((t) => t.speaker === "agent" && t.isFinal);
    assert.equal(agentFinal.text, "That's outside our band right now.");

    assert.deepEqual(events.audio, ["QUJD"], "reply.audio data is passed through verbatim");
  });
});

test("logs a move from tool.call and answers with a JSON-string tool.result", async () => {
  await withSession({}, async ({ mock, events }) => {
    const conn = mock.agentConnection();

    // The agent always emits reply.started before tool.call in a real session.
    conn.send({ type: "reply.started", reply_id: "r1" });
    await wait(15);
    conn.send({
      type: "tool.call",
      call_id: "call_1",
      name: "log_negotiation_move",
      arguments: { move_type: "counter_offer", quote: "I'd like $105,000.", number_mentioned: 105000, rationale: "Named a number." },
    });
    await wait(30);

    assert.equal(events.toolCalls.length, 1);
    assert.equal(events.toolCalls[0].toolName, "log_negotiation_move");
    assert.equal(events.toolCalls[0].input.number_mentioned, 105000);

    // tool.result must wait for reply.done, and result must be a JSON *string*.
    assert.equal(conn.received.filter((m) => m.type === "tool.result").length, 0);

    conn.send({ type: "reply.done", reply_id: "r1", status: "completed" });
    await wait(30);

    const results = conn.received.filter((m) => m.type === "tool.result");
    assert.equal(results.length, 1, "tool.result should be sent once reply.done lands");
    assert.equal(results[0].call_id, "call_1");
    assert.equal(typeof results[0].result, "string");
    assert.doesNotThrow(() => JSON.parse(results[0].result));
  });
});


test("signals a barge-in flush and discards the interrupted reply's tool results", async () => {
  await withSession({}, async ({ mock, events }) => {
    const conn = mock.agentConnection();

    // reply.started must arrive first so _currentReplyId is set
    conn.send({ type: "reply.started", reply_id: "r2" });
    await wait(15);
    conn.send({
      type: "tool.call",
      call_id: "call_2",
      name: "log_negotiation_move",
      arguments: { move_type: "deflection", quote: "Hmm.", rationale: "Stalled." },
    });
    await wait(25);
    conn.send({ type: "reply.done", reply_id: "r2", status: "interrupted" });
    await wait(40);

    assert.equal(events.interrupts, 1, "the browser must be told to drop stale audio");
    assert.equal(
      conn.received.filter((m) => m.type === "tool.result").length,
      0,
      "the agent moved on, so the pending result for r2 is discarded",
    );
  });
});

test("tool result for a non-interrupted reply survives a concurrent rapid barge-in", async () => {
  await withSession({}, async ({ mock, events }) => {
    const conn = mock.agentConnection();

    // First reply starts and gets a tool call, then gets interrupted
    conn.send({ type: "reply.started", reply_id: "r_a" });
    await wait(15);
    conn.send({
      type: "tool.call",
      call_id: "call_a",
      name: "log_negotiation_move",
      arguments: { move_type: "anchor", quote: "I need $110k.", rationale: "Anchored high." },
    });
    await wait(15);
    // Second reply starts (overlapping, e.g. agent responded immediately)
    conn.send({ type: "reply.started", reply_id: "r_b" });
    await wait(15);
    conn.send({
      type: "tool.call",
      call_id: "call_b",
      name: "log_negotiation_move",
      arguments: { move_type: "counter_offer", quote: "$108k?", rationale: "Counter." },
    });
    await wait(15);

    // First reply gets interrupted -- call_a's result should be dropped, call_b's should survive
    conn.send({ type: "reply.done", reply_id: "r_a", status: "interrupted" });
    await wait(25);

    // No results flushed yet (r_b hasn't completed)
    assert.equal(
      conn.received.filter((m) => m.type === "tool.result").length,
      0,
      "no results should flush before r_b completes",
    );

    // Second reply completes cleanly
    conn.send({ type: "reply.done", reply_id: "r_b", status: "completed" });
    await wait(40);

    const results = conn.received.filter((m) => m.type === "tool.result");
    assert.equal(results.length, 1, "only call_b's result should be flushed");
    assert.equal(results[0].call_id, "call_b", "call_a was dropped with r_a's interrupt; call_b survived");
    assert.equal(events.interrupts, 1, "exactly one interrupt signal sent to browser");
  });
});

test("rapid sequential barge-ins do not leave the agent in a frozen state", async () => {
  await withSession({}, async ({ mock, session, events }) => {
    const conn = mock.agentConnection();

    // Simulate 5 rapid-fire barge-ins within 90 seconds (worst case from user report)
    for (let i = 1; i <= 5; i++) {
      const replyId = `r_rapid_${i}`;
      conn.send({ type: "reply.started", reply_id: replyId });
      await wait(10);
      conn.send({ type: "reply.audio", data: "QUJD" });
      await wait(10);
      // User speaks over Alex immediately
      session.sendAudioChunk(Buffer.alloc(1200, i).toString("base64"));
      await wait(10);
      conn.send({ type: "reply.done", reply_id: replyId, status: "interrupted" });
      await wait(30);
    }

    assert.equal(events.interrupts, 5, "all 5 interrupts must be signalled to the browser");

    // After all interrupts, the agent leg must still be OPEN and ready to receive
    assert.ok(
      session.agentWs && session.agentWs.readyState === session.agentWs.OPEN,
      "agent WebSocket must still be OPEN after 5 rapid barge-ins",
    );
    assert.equal(session.agentReady, true, "agentReady flag must remain true after rapid barge-ins");
    assert.equal(session.pendingToolResults.size, 0, "no orphaned results should remain in the Map");

    // Confirm the session can still accept a normal reply.done after the storm
    const replyId = "r_recovery";
    conn.send({ type: "reply.started", reply_id: replyId });
    await wait(15);
    conn.send({
      type: "tool.call",
      call_id: "call_recovery",
      name: "log_negotiation_move",
      arguments: { move_type: "counter_offer", quote: "$105k final.", rationale: "After barge-in storm." },
    });
    await wait(20);
    conn.send({ type: "reply.done", reply_id: replyId, status: "completed" });
    await wait(40);

    const results = conn.received.filter((m) => m.type === "tool.result");
    assert.equal(results.length, 1, "recovery move must produce exactly one tool.result");
    assert.equal(results[0].call_id, "call_recovery", "recovery tool result must have the right call_id");
  });
});

test("reaches the word-level STT leg and forwards Turn word timings", async () => {
  await withSession({}, async ({ mock, events }) => {
    const stt = mock.sttConnection();
    assert.ok(stt, "the word-level leg should have connected");
    assert.equal(stt.headers.authorization, "test-key", "the streaming API takes a bare key, no Bearer prefix");
    assert.match(stt.search, /speech_model=universal-3-5-pro/);
    assert.match(stt.search, /sample_rate=24000/);
    assert.match(stt.search, /encoding=pcm_s16le/);

    // Partial turns must be ignored: only completed turns carry final timings.
    stt.send({ type: "Turn", turn_order: 0, end_of_turn: false, transcript: "I was thinking" });
    await wait(20);
    stt.send({
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
    await wait(40);

    const sttTurns = events.transcripts.filter((t) => t.source === "stt");
    assert.equal(sttTurns.length, 1, "only the completed turn should be forwarded");
    assert.equal(sttTurns[0].isFinal, true);
    assert.equal(sttTurns[0].speaker, "user");
    assert.equal(sttTurns[0].words.length, 7);
    assert.equal(sttTurns[0].words[4].text, "ninety");
    assert.equal(sttTurns[0].words[4].start, 2400);
    assert.equal(sttTurns[0].words[4].confidence, 0.99);

    // And that payload is exactly what the tell detectors consume.
    const { detectTells } = require("../src/scoring/tellDetection");
    const tells = detectTells(sttTurns[0].words, { avgWordsPerSecond: 0 });
    assert.deepEqual(tells.map((t) => t.type), ["hesitation"]);
    assert.equal(tells[0].gapMs, 1500);
  });
});

test("forwards audio to both legs in their required encodings", async () => {
  await withSession({}, async ({ session, mock }) => {
    const chunk = Buffer.alloc(2400, 7).toString("base64");
    session.sendAudioChunk(chunk);
    await wait(40);

    const agent = mock.agentConnection();
    const audioMsg = agent.received.find((m) => m.type === "input.audio");
    assert.ok(audioMsg, "the Voice Agent leg takes base64 JSON");
    assert.equal(audioMsg.audio, chunk);

    const stt = mock.sttConnection();
    assert.equal(stt.binary.length, 1, "the streaming leg takes raw binary frames");
    assert.ok(Buffer.isBuffer(stt.binary[0]));
    assert.equal(stt.binary[0].length, 2400);
  });
});

test("ends cleanly with session.end so the session stops billing", async () => {
  const { VoiceAgentSession } = require("../src/voiceAgentSession");
  const mock = await startMock();
  process.env.ASSEMBLYAI_API_KEY = "test-key";
  process.env.ASSEMBLYAI_AGENT_WS_URL = `ws://127.0.0.1:${mock.port}/agent`;
  process.env.ASSEMBLYAI_STREAMING_WS_URL = `ws://127.0.0.1:${mock.port}/stt`;

  const session = new VoiceAgentSession({
    sessionId: "s_end",
    scenarioConfig: { candidateTargetSalary: 100000, aiOpeningOffer: 85000, aiCeiling: 110000, companyName: "X", roleTitle: "Y" },
  });

  await session.ready;
  await wait(20);
  session.endSession();
  await wait(40);

  const agent = mock.agentConnection();
  assert.ok(
    agent.received.some((m) => m.type === "session.end"),
    "closing without session.end leaves a billable 30s resume window",
  );
  const stt = mock.sttConnection();
  assert.ok(stt.received.some((m) => m.type === "Terminate"), "the streaming leg should be terminated too");

  await mock.close();
});
