/**
 * voiceAgentSession.js
 *
 * One instance per active negotiation session. Owns the connection to the
 * AssemblyAI Voice Agent API and translates its event stream into the callback
 * contract in spec B.2.
 *
 * Spec: negotiation_dojo_full_spec.md section B.2
 *
 * ---------------------------------------------------------------------------
 * CONFIRMED AGAINST THE LIVE API DOCS (this is the part the spec told us to check)
 * ---------------------------------------------------------------------------
 * Endpoint:      wss://agents.assemblyai.com/v1/ws
 * Auth:          Authorization: Bearer <ASSEMBLYAI_API_KEY>
 * Audio:         base64 PCM16 mono 24 kHz, ~50 ms per chunk, streamed in real time
 * Handshake:     session.update -> session.ready -> then input.audio
 * Teardown:      session.end (without it the session stays billable for a 30s window)
 *
 * Event names in the spec's contract map to the real API like this:
 *   spec "agent audio"   -> reply.audio      { data }
 *   spec "tool_use"      -> tool.call        { call_id, name, arguments }  (arguments is a dict)
 *   spec tool result     -> tool.result      { call_id, result } (result must be a JSON *string*,
 *                                              sent when reply.done is the latest event)
 *   spec "user partial"  -> transcript.user.delta { text } (full text so far -- replace it)
 *   spec "user final"    -> transcript.user  { text }
 *   spec "agent final"   -> transcript.agent { text }
 *
 * THE ONE MATERIAL GAP: transcript.user carries only { text, item_id }. It has no
 * word-level timestamps and no confidence, so the spec's four tell detectors
 * (B.5) have no input on that event. Word-level data is only exposed for the
 * AGENT's speech (transcript.agent.delta). Tell detection therefore runs on a
 * second, parallel AssemblyAI Streaming STT (v3) connection fed the same mic
 * audio, which emits exactly the needed shape:
 *   Turn { transcript, words: [{ text, start, end, confidence }] }
 * That leg lives inside this file so the file tree stays exactly as spec part G.
 */

const WebSocket = require("ws");

const { buildSystemPrompt, buildGreeting } = require("./personas/hiringManager");
const { toVoiceAgentToolDefinition } = require("./tools/logNegotiationMove");

const VOICE_AGENT_URL = "wss://agents.assemblyai.com/v1/ws";
const STREAMING_STT_URL = "wss://streaming.assemblyai.com/v3/ws";

/** Voice Agent API audio contract: base64 PCM16 mono 24 kHz. */
const SAMPLE_RATE = 24000;
const AGENT_VOICE = "alba";

/** Chunks held while a leg is still handshaking (~3s of audio at 50ms/chunk). */
const MAX_QUEUED_CHUNKS = 60;

/** Backstop for the start-up handshake; the API itself times out at 10s. */
const READY_TIMEOUT_MS = 15000;

const TRANSCRIPTION_PROMPT =
  "A salary negotiation phone call about a job offer. Expect dollar figures spoken as round " +
  "numbers such as ninety five thousand or one hundred and five thousand, and the terms base " +
  "salary, equity, signing bonus, compensation band, and walk-away number.";

const KEYTERMS = [
  "base salary",
  "signing bonus",
  "equity",
  "compensation band",
  "walk-away",
  "counter-offer",
  "cost of living",
  "early review",
];

class VoiceAgentSession {
  constructor({ sessionId, scenarioConfig, onTranscript, onToolCall, onAgentAudio, onInterrupt, onError }) {
    this.sessionId = sessionId;
    this.scenarioConfig = scenarioConfig;

    this.onTranscript = onTranscript || (() => {});
    this.onToolCall = onToolCall || (() => {});
    this.onAgentAudio = onAgentAudio || (() => {});
    this.onInterrupt = onInterrupt || (() => {});
    this.onError = onError || (() => {});

    this.apiKey = process.env.ASSEMBLYAI_API_KEY || "";
    this.tellSttEnabled = String(process.env.ENABLE_TELL_STT_LEG ?? "true").toLowerCase() !== "false";

    // Resolved per instance (not at module load) so the endpoints can be pointed
    // at a mock server in tests.
    this.agentUrl = process.env.ASSEMBLYAI_AGENT_WS_URL || VOICE_AGENT_URL;
    this.sttUrl = process.env.ASSEMBLYAI_STREAMING_WS_URL || STREAMING_STT_URL;

    this.ended = false;
    this.agentReady = false;
    this.sttReady = false;
    this.sttDegraded = false;

    this.agentQueue = [];
    this.sttQueue = [];
    // Keyed by reply_id: { call_id, result }[]
    // Using a Map instead of a flat array means a rapid second interruption
    // only clears results that belong to *that specific reply*, not ones
    // already queued for the reply that follows it.
    this.pendingToolResults = new Map(); // replyId -> [{ call_id, result }]
    this.agentPartialByReply = new Map();

    // Barge-in state tracking (diagnostic: detect rapid sequential interrupts)
    this._bargeInCount = 0;
    this._lastBargeInAt = 0;
    this._pendingReply = false;

    // Application-level keepalive timers for both AAI legs.
    // AssemblyAI's proxy (and Cloudflare/Render in front of us) will drop a
    // WebSocket connection that sends NO frames for ~30-60 seconds. Audio
    // itself keeps the agent leg alive while the user is speaking, but if
    // both sides are silent for more than ~25s (e.g. the candidate is reading
    // the offer and not talking) we need to send an explicit keepalive.
    this._agentKeepaliveInterval = null;
    this._sttKeepaliveInterval = null;

    const KEEPALIVE_MS = 25000;
    this._agentKeepaliveInterval = setInterval(() => {
      if (this.ended) return;
      if (this.agentWs && this.agentWs.readyState === WebSocket.OPEN) {
        try {
          // The Voice Agent API ignores unknown types; a ping frame keeps the
          // TCP connection alive without affecting the conversation state.
          this.agentWs.ping();
        } catch (err) {
          console.warn(`[diag:agent-keepalive ${this.sessionId}] ping failed: ${err.message}`);
        }
      } else {
        console.warn(`[diag:agent-keepalive ${this.sessionId}] agent leg not OPEN during keepalive check (state: ${this.agentWs?.readyState})`);
      }
    }, KEEPALIVE_MS);

    this._sttKeepaliveInterval = setInterval(() => {
      if (this.ended || this.sttDegraded) return;
      if (this.sttWs && this.sttWs.readyState === WebSocket.OPEN) {
        try {
          this.sttWs.ping();
        } catch (err) {
          console.warn(`[diag:stt-keepalive ${this.sessionId}] ping failed: ${err.message}`);
        }
      }
    }, KEEPALIVE_MS);

    /** Resolves on session.ready, rejects on pre-ready failure. */
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    // Nothing awaits this until server.js does; keep Node from warning.
    this.ready.catch(() => {});

    this._readyTimer = setTimeout(() => {
      this._failReady(new Error("agent_timeout"));
    }, READY_TIMEOUT_MS);

    this._connectAgentLeg();
    if (this.tellSttEnabled) this._connectSttLeg();
  }

  _failReady(err) {
    if (this.readySettled) return;
    this.readySettled = true;
    clearTimeout(this._readyTimer);
    this._rejectReady(err);
  }

  _settleReady() {
    if (this.readySettled) return;
    this.readySettled = true;
    clearTimeout(this._readyTimer);
    this._resolveReady();
  }

  // -------------------------------------------------------------------------
  // Voice Agent leg
  // -------------------------------------------------------------------------

  _connectAgentLeg() {
    if (!this.apiKey) {
      this._emitError("AAI_CONNECTION_LOST", "ASSEMBLYAI_API_KEY is not set on the backend.");
      this._failReady(new Error("missing_api_key"));
      return;
    }

    let ws;
    try {
      ws = new WebSocket(this.agentUrl, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (err) {
      this._emitError("AAI_CONNECTION_LOST", `Could not open the voice agent connection: ${err.message}`);
      this._failReady(err);
      return;
    }
    this.agentWs = ws;

    ws.on("open", () => {
      console.log(`[diag:agent-open ${this.sessionId}] Voice Agent WS opened to ${this.agentUrl} @ ${new Date().toISOString()}`);
      this._sendAgent({
        type: "session.update",
        session: {
          system_prompt: buildSystemPrompt(this.scenarioConfig),
          greeting: buildGreeting(this.scenarioConfig),
          input: {
            format: { encoding: "audio/pcm" },
            transcription_prompt: TRANSCRIPTION_PROMPT,
            keyterms: KEYTERMS,
            voice_focus: "near-field",
          },
          output: { format: { encoding: "audio/pcm" }, voice: AGENT_VOICE },
          tools: [toVoiceAgentToolDefinition()],
        },
      });
    });

    ws.on("message", (raw) => this._handleAgentEvent(raw));

    ws.on("pong", () => {});

    ws.on("error", (err) => {
      const message = `Voice agent connection error: ${err.message}`;
      console.error(`[diag:agent-error ${this.sessionId}] ${message} @ ${new Date().toISOString()}`);
      this._emitError("AAI_CONNECTION_LOST", message);
      this._failReady(err);
    });

    ws.on("close", (code, reason) => {
      const reasonStr = reason ? reason.toString() : "(no reason)";
      console.warn(`[diag:agent-close ${this.sessionId}] agent leg closed: code=${code} reason=${reasonStr} ended=${this.ended} agentReady=${this.agentReady} @ ${new Date().toISOString()}`);
      if (this.ended) return;
      this.agentReady = false;
      this._emitError("AAI_CONNECTION_LOST", `Voice agent connection closed unexpectedly (code ${code}).`);
      this._failReady(new Error(`closed_pre_ready_${code}`));
    });
  }

  _handleAgentEvent(raw) {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case "session.ready": {
        // Only now may we stream audio.
        this.agentReady = true;
        this.assemblySessionId = event.session_id;
        this._settleReady();
        this._flush(this.agentQueue, (chunk) => this._sendAgentAudio(chunk));
        break;
      }

      case "transcript.user.delta":
        // `text` is the full transcript so far -- the client replaces, never appends.
        this.onTranscript({ speaker: "user", text: event.text || "", isFinal: false, source: "agent" });
        break;

      case "transcript.user":
        this.onTranscript({
          speaker: "user",
          text: event.text || "",
          isFinal: true,
          // Word-level data is not available on this event; see the header note.
          words: [],
          source: "agent",
        });
        break;


      case "reply.audio":
        if (event.data) this.onAgentAudio(event.data);
        break;

      case "transcript.agent.delta": {
        const key = event.reply_id || "current";
        const soFar = (this.agentPartialByReply.get(key) || "") + " " + (event.delta || "");
        const text = soFar.replace(/\s+/g, " ").trim();
        this.agentPartialByReply.set(key, text);
        if (text) this.onTranscript({ speaker: "agent", text, isFinal: false, source: "agent" });
        break;
      }

      case "transcript.agent":
        if (event.reply_id) this.agentPartialByReply.delete(event.reply_id);
        this.onTranscript({
          speaker: "agent",
          text: event.text || "",
          isFinal: true,
          source: "agent",
        });
        break;

      case "reply.done": {
        const now = Date.now();
        if (event.status === "interrupted") {
          // Barge-in: drop results that belong ONLY to this interrupted reply.
          // Using the reply_id key means tool results already queued for the
          // *next* reply (which may have started before this event arrives)
          // are left intact and will flush when that reply completes.
          const replyId = event.reply_id || "__default__";
          const droppedCount = (this.pendingToolResults.get(replyId) || []).length;
          this.pendingToolResults.delete(replyId);

          this._bargeInCount++;
          const msSinceLast = this._lastBargeInAt ? now - this._lastBargeInAt : null;
          this._lastBargeInAt = now;
          this._pendingReply = false;
          console.log(
            `[diag:barge-in ${this.sessionId}] interrupt #${this._bargeInCount}` +
            (msSinceLast !== null ? ` (${msSinceLast}ms since last)` : " (first)") +
            ` droppedResults=${droppedCount} remainingReplies=${this.pendingToolResults.size}` +
            ` reply_id=${replyId} @ ${new Date().toISOString()}`
          );
          if (this._bargeInCount >= 3 && msSinceLast !== null && msSinceLast < 8000) {
            console.warn(
              `[diag:barge-in ${this.sessionId}] RAPID BARGE-IN: ${this._bargeInCount} interrupts,` +
              ` last ${msSinceLast}ms ago. reply-keyed map protects subsequent results.`
            );
          }
          this.onInterrupt();
        } else {
          this._pendingReply = false;
          this._flushToolResults(event.reply_id || "__default__");
        }
        break;
      }

      case "tool.call": {
        const input = event.arguments && typeof event.arguments === "object" ? event.arguments : {};
        this.onToolCall({ toolName: event.name, input, callId: event.call_id });
        if (event.call_id) {
          // Store under the reply_id of the reply this tool call belongs to,
          // which is tracked via _currentReplyId set by reply.started.
          const replyId = this._currentReplyId || "__default__";
          if (!this.pendingToolResults.has(replyId)) {
            this.pendingToolResults.set(replyId, []);
          }
          this.pendingToolResults.get(replyId).push({
            call_id: event.call_id,
            result: JSON.stringify({ ok: true }),
          });
        }
        break;
      }

      case "reply.started":
        this._pendingReply = true;
        this._currentReplyId = event.reply_id || "__default__";
        this.agentPartialByReply.set(event.reply_id, "");
        break;

      case "session.ended":
        console.log(`[diag:agent-event ${this.sessionId}] session.ended received @ ${new Date().toISOString()}`);
        this.ended = true;
        break;

      case "session.error": {
        const fatal = new Set([
          "UNAUTHORIZED", "FORBIDDEN", "session_not_found", "session_forbidden",
          "session_expired", "agent_init_failed", "agent_timeout", "server_error",
          "INTERNAL_ERROR", "at_capacity", "concurrency_exceeded",
        ]);
        const message = event.message || event.code || "Unknown voice agent error";
        this._emitError("AAI_CONNECTION_LOST", message);
        if (fatal.has(event.code) || !this.agentReady) this._failReady(new Error(event.code || "session_error"));
        break;
      }

      default:
        break; // session.updated, input.speech.*, heartbeats -- nothing to relay
    }
  }

  /**
   * Flush tool results for a specific reply, or ALL pending results if no
   * replyId is given (used by endSession to drain any leftovers).
   */
  _flushToolResults(replyId) {
    if (replyId) {
      const bucket = this.pendingToolResults.get(replyId);
      if (!bucket || !bucket.length) return;
      for (const pending of bucket) {
        this._sendAgent({ type: "tool.result", call_id: pending.call_id, result: pending.result, is_error: false });
      }
      this.pendingToolResults.delete(replyId);
    } else {
      // Drain everything (called on endSession)
      for (const [, bucket] of this.pendingToolResults) {
        for (const pending of bucket) {
          this._sendAgent({ type: "tool.result", call_id: pending.call_id, result: pending.result, is_error: false });
        }
      }
      this.pendingToolResults.clear();
    }
  }

  _sendAgent(payload) {
    if (this.agentWs && this.agentWs.readyState === WebSocket.OPEN) {
      try {
        this.agentWs.send(JSON.stringify(payload));
        return true;
      } catch (err) {
        console.warn(`[voiceAgentSession ${this.sessionId}] sendAgent error: ${err.message}`);
        return false;
      }
    }
    return false;
  }

  _sendAgentAudio(base64Chunk) {
    this._sendAgent({ type: "input.audio", audio: base64Chunk });
  }

  // -------------------------------------------------------------------------
  // Word-level Streaming STT leg (tell detection)
  // -------------------------------------------------------------------------

  _connectSttLeg() {
    if (!this.apiKey) return;

    const params = new URLSearchParams({
      speech_model: "universal-3-5-pro",
      encoding: "pcm_s16le",
      sample_rate: String(SAMPLE_RATE),
      mode: "balanced",
      include_partial_turns: "false",
    });

    let ws;
    try {
      // NOTE: the streaming API takes the raw key here, with NO "Bearer" prefix.
      ws = new WebSocket(`${this.sttUrl}?${params.toString()}`, {
        headers: { Authorization: this.apiKey },
      });
    } catch (err) {
      this._degradeStt(`could not open: ${err.message}`);
      return;
    }
    this.sttWs = ws;

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "Begin":
          this.sttReady = true;
          this._flush(this.sttQueue, (chunk) => this._sendSttAudio(chunk));
          break;

        case "Turn":
          // Only completed turns carry the final word timings the detectors need.
          if (msg.end_of_turn !== true) break;
          this.onTranscript({
            speaker: "user",
            text: msg.transcript || "",
            isFinal: true,
            words: Array.isArray(msg.words) ? msg.words : [],
            source: "stt",
          });
          break;

        case "Termination":
          this.sttReady = false;
          break;

        case "error":
          this._degradeStt(msg.error || "streaming STT error");
          break;

        default:
          break; // SpeechStarted, Heartbeat
      }
    });

    ws.on("open", () => {
      console.log(`[diag:stt-open ${this.sessionId}] Streaming STT WS opened @ ${new Date().toISOString()}`);
    });

    ws.on("pong", () => {});

    ws.on("error", (err) => {
      console.error(`[diag:stt-error ${this.sessionId}] ${err.message} @ ${new Date().toISOString()}`);
      this._degradeStt(err.message);
    });

    ws.on("close", (code, reason) => {
      const reasonStr = reason ? reason.toString() : "(no reason)";
      console.warn(`[diag:stt-close ${this.sessionId}] STT leg closed: code=${code} reason=${reasonStr} ended=${this.ended} sttReady=${this.sttReady} @ ${new Date().toISOString()}`);
      this.sttReady = false;
      if (!this.ended) this._degradeStt(`connection closed (code ${code})`);
    });
  }

  /**
   * The STT leg is auxiliary: if it dies the conversation must continue. Tell
   * detection is lost, but the negotiation and the scorecard still work.
   */
  _degradeStt(reason) {
    if (this.sttDegraded) return;
    this.sttDegraded = true;
    console.warn(`[voiceAgentSession ${this.sessionId}] word-level STT leg degraded: ${reason}`);
    this.onError({
      code: "TELL_DETECTION_DEGRADED",
      message: "Word-level tell detection is unavailable for this session; the negotiation itself is unaffected.",
    });
  }

  _sendSttAudio(base64Chunk) {
    if (!this.sttWs || this.sttWs.readyState !== WebSocket.OPEN) return;
    try {
      // The streaming API expects raw binary frames, not base64 JSON.
      this.sttWs.send(Buffer.from(base64Chunk, "base64"));
    } catch {
      this._degradeStt("failed to forward audio");
    }
  }

  // -------------------------------------------------------------------------
  // Audio intake
  // -------------------------------------------------------------------------

  _flush(queue, send) {
    if (!queue.length) return;
    if (queue.length > MAX_QUEUED_CHUNKS) {
      // Replaying a large backlog faster than real time trips audio_rate_violation
      // and corrupts transcription, so drop the excess instead.
      const dropped = queue.length - MAX_QUEUED_CHUNKS;
      queue.splice(0, dropped);
      console.warn(`[voiceAgentSession ${this.sessionId}] dropped ${dropped} stale audio chunk(s) while handshaking`);
    }
    for (const chunk of queue.splice(0)) send(chunk);
  }

  sendAudioChunk(base64AudioChunk) {
    if (this.ended || typeof base64AudioChunk !== "string" || !base64AudioChunk) return;

    if (this.agentReady) {
      this._sendAgentAudio(base64AudioChunk);
    } else if (this.agentQueue.length < MAX_QUEUED_CHUNKS * 4) {
      // session.ready must arrive before the first input.audio.
      this.agentQueue.push(base64AudioChunk);
    }

    if (!this.tellSttEnabled) return;
    if (this.sttReady) {
      this._sendSttAudio(base64AudioChunk);
    } else if (!this.sttDegraded && this.sttQueue.length < MAX_QUEUED_CHUNKS * 4) {
      this.sttQueue.push(base64AudioChunk);
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  endSession() {
    if (this.ended) return;
    console.log(`[diag:teardown ${this.sessionId}] endSession called: agentReady=${this.agentReady} sttReady=${this.sttReady} bargeInCount=${this._bargeInCount} @ ${new Date().toISOString()}`);
    this.ended = true;
    this.agentReady = false;
    this.sttReady = false;
    clearTimeout(this._readyTimer);
    if (this._agentKeepaliveInterval) { clearInterval(this._agentKeepaliveInterval); this._agentKeepaliveInterval = null; }
    if (this._sttKeepaliveInterval) { clearInterval(this._sttKeepaliveInterval); this._sttKeepaliveInterval = null; }

    this._flushToolResults();

    // session.end stops billing immediately; just closing the socket would keep
    // the session (and the invoice) alive for a 30 second resume window.
    this._sendAgent({ type: "session.end" });
    if (this.sttWs && this.sttWs.readyState === WebSocket.OPEN) {
      try {
        this.sttWs.send(JSON.stringify({ type: "Terminate" }));
      } catch {
        /* ignore */
      }
    }

    const closeAll = () => {
      for (const ws of [this.agentWs, this.sttWs]) {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
      }
    };
    setTimeout(closeAll, 250);
  }

  _emitError(code, message) {
    this.onError({ code, message });
  }
}

module.exports = { VoiceAgentSession, SAMPLE_RATE, VOICE_AGENT_URL, STREAMING_STT_URL };
