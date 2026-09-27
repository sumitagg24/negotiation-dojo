# Architecture

Negotiation Dojo is a live voice negotiation trainer built on the AssemblyAI Voice Agent API. This
document records the system design, the API contracts as they actually exist (verified against the
live docs on 2026-09-27), and every place the implementation departs from the original spec.

---

## 1. Data flow

```
SetupScreen
  │  POST /api/session/start { candidateTargetSalary, candidateWalkaway, companyName?, roleTitle? }
  ▼
Backend
  │  derives aiOpeningOffer = round(target × 0.85), aiCeiling = round(target × 1.10)
  │  creates the session, opens BOTH AssemblyAI legs, waits for session.ready
  │  ◄── 502 with a readable message if the connection cannot be established
  │  returns { sessionId, wsPath }
  ▼
LiveSessionScreen
  │  getUserMedia -> AudioWorklet -> 50 ms PCM16 24 kHz chunks
  │  WebSocket to /ws/session/:id
  ▼
Backend
  ├─► Voice Agent leg  : audio in, transcripts + TTS audio + tool calls out
  └─► Streaming STT leg: same audio, completed turns with word timings out
  │
  ├─ transcript (agent leg) ──────────────► transcript_partial / transcript_final
  ├─ reply.audio ────────────────────────► agent_audio_chunk
  ├─ reply.done(interrupted) ────────────► agent_audio_flush
  ├─ tool.call ──► sessionStore ─────────► move_logged
  └─ final Turn w/ words ──► detectTells ─► tell_detected
  ▼
End Session (button or REST)
  │  close both legs -> compute sub-scores -> ONE LLM call -> assemble scorecard
  ▼
ScorecardScreen
```

### Scenario calibration

`aiOpeningOffer` and `aiCeiling` are derived server-side and never accepted from the client, so every
session is winnable-with-good-tactics but not trivial:

```js
aiOpeningOffer = Math.round(candidateTargetSalary * 0.85)  // opens ~15% below target
aiCeiling      = Math.round(candidateTargetSalary * 1.10)  // secretly can go 10% above
```

`companyName` and `roleTitle` default to `"Northbeam Analytics"` and `"Senior Software Engineer"`.

---

## 2. AssemblyAI contracts, as they actually are

### 2.1 Voice Agent API

`wss://agents.assemblyai.com/v1/ws`, `Authorization: Bearer <key>`, base64 PCM16 mono 24 kHz.

Handshake: `session.update` → `session.ready` → only then `input.audio`. Audio must be streamed in
real time; frames beyond ~1 s of audio per second of wall clock are dropped, not buffered.

| Real event | Direction | Our mapping |
| --- | --- | --- |
| `session.update` | → | persona prompt, greeting, tools, audio config |
| `session.ready` | ← | resolves the startup promise; flushes queued audio |
| `input.audio` | → | one browser audio chunk each |
| `transcript.user.delta` | ← | `transcript_partial` (text is cumulative — **replace, never concatenate**) |
| `transcript.user` | ← | `transcript_final` (user) |
| `transcript.agent.delta` | ← | accumulated → agent partials, aligned to playback |
| `transcript.agent` | ← | `transcript_final` (agent) |
| `reply.audio` | ← | `agent_audio_chunk` (`data` field) |
| `reply.done` | ← | `status: "interrupted"` → `agent_audio_flush`; else flush pending tool results |
| `tool.call` | ← | `log_negotiation_move` → `move_logged` (`arguments` arrives already parsed as a dict) |
| `tool.result` | → | sent only when `reply.done` is the latest event; `result` must be a JSON **string** |
| `session.end` | → | teardown. Skipping it leaves the session billable for a 30 s resume window |
| `session.error` | ← | classified fatal/non-fatal, surfaced as `AAI_CONNECTION_LOST` |

### 2.2 Streaming STT v3 (the word-level leg)

`wss://streaming.assemblyai.com/v3/ws`, `Authorization: <key>` — **no `Bearer` prefix**, unlike the
Voice Agent API. Query params: `speech_model=universal-3-5-pro`, `encoding=pcm_s16le`,
`sample_rate=24000`, `mode=balanced`, `include_partial_turns=false`.

Audio goes out as **raw binary frames**, not base64 JSON. `Terminate` stops the session.

```
Turn { turn_order, end_of_turn, transcript, words: [ { text, start, end, confidence } ] }
```

Only `end_of_turn: true` turns are used; those are exactly the shape `tellDetection.js` consumes.

---

## 3. The word-level problem (the most important decision here)

**The spec's differentiator had no input on the real API.** Spec B.5 defines four tell detectors that
require per-word `start`, `end` and `confidence` on the candidate's speech. The live
`transcript.user` event is:

```json
{ "type": "transcript.user", "text": "What's the weather in Tokyo?", "item_id": "item_abc123" }
```

No words, no timings, no confidence. Word-level data is exposed only for the *agent's* speech
(`transcript.agent.delta` carries `start_ms`/`end_ms`), which is useless for reading the candidate.

Two options existed:

1. **Derive timings from what we do get** — `input.speech.started` / `input.speech.stopped` bracket
   an utterance, and `transcript.user.delta` arrival times give coarse word positions. Free, but
   gives up confidence entirely (killing the mumbled-number detector) and produces soft timing.
2. **Add a parallel word-level STT leg** and feed it the same mic audio.

Option 2 was chosen: it is the only way to satisfy acceptance row 4 for real, and it costs
$0.45/hr on top of the agent's $4.50/hr. It lives **inside `voiceAgentSession.js`** as
`_connectSttLeg()`, so the file tree stays exactly as spec Part G specifies. The leg is auxiliary: if
it fails, `_degradeStt()` reports `TELL_DETECTION_DEGRADED` once and the negotiation, moves and
scorecard all continue to work. Set `ENABLE_TELL_STT_LEG=false` to run without it.

Because the two legs segment speech independently, they cannot be reliably aligned turn-by-turn.
Rather than duplicate the transcript, each `onTranscript` payload is tagged with its `source`:

- `source: "agent"` → forwarded to the browser as the conversation transcript.
- `source: "stt"` → **not** forwarded; used only to run the tell detectors.

### Number parsing

STT returns spoken numbers, and one figure usually spans several tokens (`"ninety five thousand"` is
three). The spec's detectors index a single token, so `detectRetraction` would have compared
`"ninety"` against `"ninety"`, seen them equal, and never fired. `extractNumberMentions()` therefore
groups adjacent number tokens into one figure before the detectors reason about it, and the detectors
keep the spec's function names, signatures, thresholds and return shapes.

Supported number forms: `92000`, `$92,000`, `92k`, `1.5m`, `ninety`, `ninety-five` (incl. un-split
compounds), `ninety five thousand`, `one hundred and twenty thousand`.

---

## 4. WebSocket protocol

### Client → server

```json
{ "type": "audio_chunk", "payload": "<base64 PCM16>" }
{ "type": "end_session" }
```

### Server → client

```json
{ "type": "session_ready", "sessionId": "abc123" }
{ "type": "transcript_partial", "speaker": "user", "text": "I was thinking around ninety f-" }
{ "type": "transcript_final", "speaker": "user", "text": "I was thinking around ninety five thousand.", "words": [] }
{ "type": "transcript_final", "speaker": "agent", "text": "That's a bit outside our band right now." }
{ "type": "agent_audio_chunk", "payload": "<base64 audio>" }
{ "type": "agent_audio_flush" }
{ "type": "tell_detected", "tellType": "hesitation", "quote": "...", "detail": { "gapMs": 1450 } }
{ "type": "move_logged", "move": { "move_type": "counter_offer", "quote": "...", "number_mentioned": 95000, "asked_for_reciprocity": false, "rationale": "..." } }
{ "type": "scorecard_ready", "scorecard": { } }
{ "type": "error", "message": "...", "code": "AAI_CONNECTION_LOST" | "MIC_PERMISSION_DENIED" | "SCORING_FAILED" | "TELL_DETECTION_DEGRADED" }
```

Two additions to the spec's table:

- **`agent_audio_flush`** — required by the real API's barge-in semantics. On `reply.done` with
  `status: "interrupted"` the server has already stopped generating, but the browser still holds
  queued PCM. Without a flush signal, stale agent speech plays over the candidate. The frontend drops
  its queued `AudioBufferSourceNode`s.
- **`TELL_DETECTION_DEGRADED`** — a non-fatal status for when the word-level leg drops.

The frontend handler is a single `switch (msg.type)` in `lib/socket.js`; nothing is inferred
positionally, and the socket's `onclose` reports `AAI_CONNECTION_LOST` so a dropped connection can
never present as a silently frozen screen.

---

## 5. Scoring

```js
anchorQuality      = userAnchoredFirst ? 1.0 : 0.4
reciprocityRatio   = reciprocalConcessions / concessions      (1.0 if no concessions needed)
tellDensity        = tells / moves                            (clamped to 0..1, lower is better)
finalOutcomeRatio  = lastNumberMentioned / candidateTargetSalary

outcomeScore = finalOutcomeRatio !== null ? min(ratio, 1.15) / 1.15 : 0.5
final_score  = round(100 × ( 0.30·anchorQuality
                          + 0.30·reciprocityRatio
                          + 0.25·(1 − tellDensity)
                          + 0.15·outcomeScore ))
```

`final_score` is always the output of this formula. The LLM is asked for prose only (its prompt
forbids a score field), and `scoreSession.js` overwrites `scorecard.final_score` regardless of what
comes back. `score_label` is derived server-side from the score using the spec C.4 bands, so the LLM
cannot contradict the number either. This is what makes "the score is a weighted formula, not a black
box" a defensible claim.

### Three corrections to the specified formula

1. **Zero-move sessions score 0, not 75.** With no logged moves every untouched term sits at its
   neutral maximum, so the raw formula awards a session where the candidate said nothing
   0.30·0.4 + 0.30·1 + 0.25·1 + 0.15·0.5 = **0.745 → 75/100, "Strong negotiator"**. Part F calls the
   empty-log case out explicitly, so `computeFinalScore(subScores, moveCount)` returns 0 when
   `moveCount === 0`.
2. **`tellDensity` is clamped to 0..1.** A talkative session can produce more tells than moves, which
   pushed `1 − tellDensity` negative and subtracted from the score.
3. **Rounding epsilon.** A mathematically exact 74.5 accumulated as `0.7449999999999999` and rounded
   *down* to 74 — flipping the label from "Strong negotiator" to "Solid, room to grow" for a score
   that had earned the higher band. `Math.round(x + 1e-9)` corrects binary representation error only.

---

## 6. Error handling

| Scenario | Behaviour |
| --- | --- |
| Mic permission denied | Full-screen state with browser instructions and **Back to setup**; the abandoned session is ended server-side so it stops billing |
| Voice agent connection fails to open | `POST /start` returns 502 with a readable cause; setup shows an inline error and a Retry button and never transitions to live |
| Connection drops mid-session | `AAI_CONNECTION_LOST` banner; logged moves/tells survive; **End Session** still scores over REST |
| Scoring LLM returns malformed JSON | Retried once with a stricter reminder appended; if it fails twice, a fallback scorecard is built from the deterministic sub-scores. Never a raw 500 |
| No moves logged at all | Scorecard renders at 0; `went_well` and `tells` are empty arrays; `biggest_leverage_loss` is `null` and the frontend shows an explanatory line instead of a blank card |
| Session ends within seconds | Same path as above — the empty log is first-class |
| Word-level STT leg dies | One `TELL_DETECTION_DEGRADED` notice; conversation, moves and scoring unaffected |
| Browser closes without ending | After 2 minutes with no client attached the backend ends the voice session to stop billing, while keeping the log so scoring still works |
| Backend restarts mid-demo | Sessions are mirrored to `SESSION_STORE_PATH` after every write |

---

## 7. All deviations from the spec, with reasoning

| # | Spec | Implementation | Why |
| --- | --- | --- | --- |
| 1 | B.8 event names (`tool_use`, `agent_audio`, …) | Real API names (`tool.call`, `reply.audio`, …) | The spec explicitly instructed adapting field names to the live API and keeping everything else identical |
| 2 | B.5 detectors read word timings from the user transcript | Added a parallel Streaming STT v3 leg inside `voiceAgentSession.js` | `transcript.user` has no timings or confidence; acceptance row 4 is unreachable without it |
| 3 | B.3 interpolates 6 variables into the persona prompt | Only the 4 the D.1 template actually uses | D.1 never references `candidateTargetSalary`/`candidateWalkaway`, and putting them in Alex's prompt would hand him the candidate's private numbers |
| 4 | B.8 protocol table | Added `agent_audio_flush` and `TELL_DETECTION_DEGRADED` | The real API's barge-in and the auxiliary-leg failure mode both need a signal |
| 5 | D.4 scorecard shape | Added `narrative_source` and `sub_scores` | Honesty about template-generated narratives, and support for the "not a black box" claim |
| 6 | D.2 tool schema verbatim | `TOOL_SCHEMA` kept verbatim, plus `toVoiceAgentToolDefinition()` | The API wants `type: "function"` and `parameters`; `execution_mode: "interactive"` is required because a hold-mode tool pauses live transcripts on every turn |
| 7 | D.1 has no greeting | `buildGreeting()` added | Without a greeting the agent stays silent until the candidate speaks, which breaks the opening-anchor dynamic the persona is built around |
| 8 | B.6 LLM client unspecified | AssemblyAI LLM Gateway default (`llm-gateway.assemblyai.com`), OpenAI-compatible override | One key for the whole app; bring-your-own still supported |
| 9 | Part G file tree | Added `frontend/index.html`, `vite.config.js`, `src/main.jsx`, `src/styles.css`, `src/lib/audio.js`, `backend/test/*`, root `.gitignore`, `LICENSE`, and this doc | A Vite app cannot build without the first four; C.7 styling needs a stylesheet; the audio engine is a real module; Part E row 4 requires runnable detector tests |
| 10 | C.1/C.3 React convention | `StrictMode` deliberately omitted | Its dev double-invocation opens two sockets and starts the mic twice for one session |
| 11 | C.3 "single persistent `<audio>` element" | Web Audio `AudioBufferSourceNode` scheduling | The agent's audio arrives as PCM16 chunks with no container, so an `<audio>` element cannot play it; a scheduling watermark is what makes chunks play gap-free and be flushable on barge-in |
| 12 | Part E row 8 `npm install` both folders | Unchanged, verified | |

---

## 8. Tuning knobs

All in `backend/src/scoring/tellDetection.js` unless noted:

| Constant | Default | Meaning |
| --- | --- | --- |
| `THRESHOLDS.hesitationGapMs` | 1200 | Silence before a figure that reads as hesitation |
| `THRESHOLDS.paceRatio` | 1.4 | Speed above the candidate's own rolling baseline |
| `THRESHOLDS.mumbleDrop` | 0.15 | Confidence drop below the utterance average |
| `AGENT_VOICE` | `alba` | Agent voice |
| `IDLE_ABANDON_MS` (server.js) | 120000 | No-client grace period before billing is stopped |
| `REST_SCORING_FALLBACK_MS` (LiveSessionScreen) | 5000 | Socket → REST scoring fallback |

The persona prompt lives **only** in `backend/src/personas/hiringManager.js`. Change behaviour there
and nowhere else.

---

## 9. Test coverage

`cd backend && npm test` — 63 tests, 0 failures, ~2.8 s.

| File | Tests | Covers |
| --- | --- | --- |
| `test/tellDetection.test.js` | 17 | Number parsing, all four detectors firing and staying silent, the orchestrator, baseline stats. Acceptance row 4 |
| `test/scoreSession.test.js` | 23 | Weighted formula, determinism, LLM-authority rule, malformed-JSON retry, fallback narrative, empty sessions, prompt integrity, store baseline |
| `test/voiceAgentSession.test.js` | 14 | Mock-AssemblyAI integration: handshake payload, transcript mapping, tool round trip, rapid sequential barge-in protection with reply-keyed map, word-level turns reaching detectors, teardown |
| `test/keepAlive.test.js` | 6 | Anti-spin-down cron keepalive execution, exponential backoff, health endpoint validation, disabled/standby guards |
| `test/traceMarkers.test.mjs` | 2 | Client-side visual pen trace alignment and detector event mapping |
| `test/fullStack.test.js` | 1 | The real `server.js` over real HTTP + WebSocket against a mock AssemblyAI: start, audio, move, tell, score, retrieve; plus the LLM-authority rule and unknown-session refusal |

Unverified: the real speech-to-speech audio round trip, which requires a live API key.

