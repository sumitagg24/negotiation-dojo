# Negotiation Dojo

[![CI](https://github.com/sumitagg24/negotiation-dojo/actions/workflows/ci.yml/badge.svg)](https://github.com/sumitagg24/negotiation-dojo/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-63%20passed-brightgreen)](https://github.com/sumitagg24/negotiation-dojo)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A live, full-duplex voice salary-negotiation trainer with forensic flight-recorder telemetry and deterministic scoring. Practice high-stakes salary conversations against an adaptive hiring manager, identify verbal tells in real time, and receive an instant forensic scorecard analyzing moves, pauses, pace spikes, and money left on the table.

- 🌐 **Live Web App:** [https://negotiation-dojo-one.vercel.app](https://negotiation-dojo-one.vercel.app)
- ⚡ **Backend Health:** [https://negotiation-dojo-backend.onrender.com/api/health](https://negotiation-dojo-backend.onrender.com/api/health)
- 📖 **Architecture Deep-Dive:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## Hackathon Judging Criteria Mapping

| Judging Criterion | Implementation & Evidence in This Repository |
|---|---|
| **Application of Technology** | **Tri-Product AssemblyAI Integration:** Powered by a single `ASSEMBLYAI_API_KEY` orchestrating three distinct AssemblyAI services: (1) **Voice Agent API** (`wss://agents.assemblyai.com/v1/ws`) for full-duplex speech-to-speech sparring, bidirectional 24 kHz PCM16 streaming, native tool calling (`log_negotiation_move`), and zero-cutoff barge-in interruption handling; (2) **Streaming STT v3** (`wss://streaming.assemblyai.com/v3/ws`, `Universal-3.5-pro`) on a parallel audio leg for millisecond-precision per-word timestamps and confidence scores powering acoustic tell detection; and (3) **LLM Gateway** (`https://llm-gateway.assemblyai.com/v1/chat/completions`) generating structured coaching prose. Production resilience includes **15s/25s keepalives** (15s browser-to-backend WebSocket heartbeats, 25s backend-to-AssemblyAI WebSocket ping frames), a reply-keyed Map protecting tool results during rapid sequential barge-ins, REST fallback scoring, and **63 passing automated tests** in CI. |
| **Presentation** | **"Black Box Flight Recorder" Experience:** Seamless transition from a clean Manila dossier setup screen into a high-contrast charcoal cockpit face during live sparring, concluding with an evidentiary forensic report. Provides real-time visual telemetry including dynamic move classification badges, active speech volume meter, rolling conversational pace baseline tracker, instant tell detection banners, and an interactive canvas flight recorder trace strip (`TraceStrip.jsx`). Includes an instant review mode (`?screen=scorecard`) allowing judges to inspect a populated forensic scorecard without a live mic call, plus `GET /api/session/:id` for full diagnostic session inspection. |
| **Business Value** | **High-Stakes Financial Mastery:** Focuses on one of the highest-leverage conversations in a professional's career, where a single discussion directly impacts compensation and lifetime earnings. Moves beyond text-based bots by coaching acoustic delivery: detecting hesitation pauses before figures (>1,200 ms), unforced price retractions, conversational pace spikes (>1.4× baseline), and mumbled numbers. Replaces subjective, hallucinated LLM grades with a **100% deterministic mathematical formula** (Anchor Quality 30%, Reciprocity Ratio 30%, Tell Discipline 25%, Outcome 15%), accompanied by quote-backed coaching breakdowns and a single actionable behavioral takeaway. |
| **Originality** | **Dual-Leg Voice Telemetry Rig:** Concurrently streams microphone audio to both a speech-to-speech agent (for conversational dialogue) and an auxiliary streaming STT model (for word-level acoustic forensics)—overcoming the metadata limitations of single-stream voice agents. Reimagines salary negotiation as flight simulation, logging chronological conversational moves and acoustic tells on a synchronized flight recorder timeline. Inverts conventional GenAI application architecture by making mathematical evaluation authoritative while constraining the LLM to authoring grounded, evidence-based tactical analysis. |

---

## System Architecture

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 BROWSER / FRONTEND                     │
                  │  Web Audio Worklet: PCM16 24 kHz mono (50 ms chunks)   │
                  │  Dual Theme: Manila Dossier (Setup/Report) & FDR Face  │
                  └───────────────────────▲──┬─────────────────────────────┘
                                          │  │ WebSocket
                                          │  │ (15s ping/pong keepalive)
                                          │  ▼
                  ┌────────────────────────────────────────────────────────┐
                  │                  BACKEND (Node.js)                     │
                  │  Express REST + ws WebSocket Server                    │
                  │  Session Store & Anti-Spin-Down Self-Ping Cron         │
                  └───────────────────────▲──┬─────────────────────────────┘
                                          │  │
                    ┌─────────────────────┘  └─────────────────────┐
                    │ 25s WS keepalive                             │ 25s WS keepalive
                    ▼                                              ▼
┌───────────────────────────────────────┐      ┌───────────────────────────────────────┐
│   AssemblyAI Voice Agent API (Leg 1)  │      │  AssemblyAI Streaming STT v3 (Leg 2)  │
│   • Full-duplex conversation & TTS    │      │   • Universal-3.5-pro speech model    │
│   • Tool calling: log_negotiation_move│      │   • Word-level timestamps & confidence│
│   • Natural barge-in interruption     │      │   • Real-time acoustic tell detection │
└───────────────────────────────────────┘      └───────────────────────────────────────┘
```

### The Dual-Leg Strategy

The AssemblyAI Voice Agent API handles full-duplex conversational voice, TTS synthesis, and interactive tool calls. Because the agent leg's `transcript.user` event provides only turn-level text without word-level timestamps or confidence scores, Negotiation Dojo simultaneously streams the raw audio to a parallel **AssemblyAI Streaming STT v3** connection. 

This enables millisecond-precision tell detection while keeping conversation latency ultra-low and the audio pipeline unified. If the auxiliary STT leg ever drops, the system degrades gracefully with `TELL_DETECTION_DEGRADED` while the core conversation and scoring continue uninterrupted.

---

## Real-Time Tell Detection Engine

Every completed user utterance is evaluated against four real-time acoustic detectors:

| Tell Detector | Trigger Condition | Coaching Significance |
|---|---|---|
| **Hesitation** | Silence duration > 1,200 ms immediately preceding a compensation figure | Signals uncertainty or lack of conviction in the proposed number. |
| **Retraction** | Mentioning a number and immediately following with a lower counter-figure | Unforced concession before the hiring manager has even pushed back. |
| **Pace Spike** | Speech rate > 1.4× above the candidate's rolling conversational baseline | Indicates conversational panic, nervousness, or rushed capitulation. |
| **Mumbled Number** | STT word confidence on a number token drops > 0.15 below utterance mean | Dropping vocal volume or trailing off when stating key figures. |

---

## Deterministic Scoring Formula

Negotiation Dojo does **not** allow an LLM to hallucinate or invent your final negotiation grade. The final score is computed by a strict mathematical formula:

$$\text{final\_score} = 100 \times \left( 0.30 \cdot \text{anchorQuality} + 0.30 \cdot \text{reciprocityRatio} + 0.25 \cdot (1 - \text{tellDensity}) + 0.15 \cdot \text{outcomeScore} \right)$$

- **Anchor Quality (30%):** 1.0 if the candidate made the first salary offer; 0.4 if the hiring manager anchored first.
- **Reciprocity Ratio (30%):** Ratio of candidate concessions made in exchange for a reciprocal counter-concession (1.0 if no concessions were required).
- **Tell Discipline (25%):** Penalizes acoustic tells per negotiation move ($1 - \text{tellDensity}$, clamped between 0.0 and 1.0).
- **Final Outcome (15%):** Ratio of final agreed number to the candidate's target salary (scaled to 1.15 ceiling).

The LLM is invoked strictly once at session teardown to author qualitative coaching prose based on the computed metrics. Even if the LLM attempts to output a score, `scoreSession.js` discards it and enforces the deterministic formula.

---

## Quickstart (Local Development)

### Prerequisites
- Node.js 18.17+
- AssemblyAI API Key ([Get one free at AssemblyAI](https://www.assemblyai.com))

### 1. Backend Setup
```bash
cd backend
cp .env.example .env
# Edit .env and paste your ASSEMBLYAI_API_KEY
npm install
npm run dev
# Backend listening on http://localhost:8080 (REST + WebSocket)
```

### 2. Frontend Setup (in a separate terminal)
```bash
cd frontend
cp .env.example .env
npm install
npm run dev
# Frontend listening on http://localhost:5173
```

3. Open **`http://localhost:5173`** in Chrome, Edge, or Firefox.
4. Enter your target salary, walk-away number, click **Start Negotiation**, and grant microphone access.

> **Tip:** Use headphones during practice. Without headphones, speaker audio may feed back into the microphone, triggering inadvertent barge-in interruptions.

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ASSEMBLYAI_API_KEY` | **Yes** | — | Single key for Voice Agent API, Streaming STT v3, and LLM Gateway. |
| `PORT` | No | `8080` | Backend HTTP & WebSocket listening port. |
| `CORS_ORIGIN` | No | `http://localhost:5173` | Allowed browser origins (comma-separated, wildcard supported). |
| `SESSION_STORE_PATH` | No | `./data/sessions.json` | Local fallback JSON mirror for in-memory sessions. |
| `ENABLE_TELL_STT_LEG` | No | `true` | Enables the parallel Streaming STT leg for word-level tell detection. |
| `KEEP_ALIVE_ENABLED` | No | `true` | Enables periodic self-ping cron to prevent cloud host sleep. |
| `KEEP_ALIVE_INTERVAL_MINUTES` | No | `10` | Interval in minutes for the keep-alive background cron. |
| `LLM_API_KEY` | No | AssemblyAI Gateway | Optional custom OpenAI-compatible API key for scorecard prose. |

### Frontend (`frontend/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_BACKEND_URL` | No | `http://localhost:8080` | Backend HTTP endpoint. |
| `VITE_BACKEND_WS_URL` | No | `ws://localhost:8080` | Backend WebSocket endpoint. |

*Note: For production deployments, `frontend/public/config.js` allows configuring the backend URL at runtime without triggering a frontend rebuild.*

---

## Verification & Test Coverage

The test suite validates the entire architecture end-to-end using Node's native test runner against mock AssemblyAI endpoints:

```bash
cd backend && npm test
```

**63 tests pass across 6 test suites with zero failures:**

- **`test/tellDetection.test.js` (17 tests):** Spoken number normalization, hesitation detection, retraction detection, pace spike baseline calculation, and mumble detection.
- **`test/scoreSession.test.js` (23 tests):** Weighted formula verification, deterministic score enforcement, LLM authority override, malformed JSON retry, empty session handling.
- **`test/voiceAgentSession.test.js` (14 tests):** Full-duplex handshake, transcript event routing, tool call execution, rapid sequential barge-in protection with reply-keyed Map, word-level turn forwarding, clean session teardown.
- **`test/keepAlive.test.js` (6 tests):** Anti-spin-down cron execution, exponential backoff, health endpoint validation, disabled/standby guards.
- **`test/traceMarkers.test.mjs` (2 tests):** Flight data recorder canvas trace alignment and detector event mapping.
- **`test/fullStack.test.js` (1 test):** Full integration test of `server.js` over real HTTP and WebSocket against mock AssemblyAI.

```bash
cd frontend && npm run build
```
Builds cleanly with Vite, generating an optimized production bundle.

---

## Production Deployment & Reliability

Negotiation Dojo is deployed across a two-tier architecture:

- **Frontend:** Deployed to **Vercel** with global CDN caching and edge asset delivery.
- **Backend:** Deployed to **Render** with persistent WebSockets for live voice streaming.

### Connection Resilience & Anti-Sleep Pipeline

Cloud-hosted voice agents face two common failure modes: proxy timeouts on silent WebSockets, and free-tier container sleep. Negotiation Dojo implements defense-in-depth:

1. **Frontend-to-Backend Heartbeat (15s):** The browser client sends an application-level ping every 15s to keep the browser-to-backend WebSocket active through reverse proxies.
2. **Backend-to-AssemblyAI Keepalive (25s):** The backend issues native WebSocket ping frames every 25s on both active AssemblyAI legs, preventing proxy disconnections during long silent pauses.
3. **Internal Keep-Alive Cron (10m):** `src/cron/keepAlive.js` detects `RENDER_EXTERNAL_URL` and pings `/api/health` from the public internet every 10 minutes to reset cloud sleep timers.
4. **GitHub Actions Warm-Up Runner:** `.github/workflows/keep-warm.yml` pings the production health check on an offset schedule as an external backup.
5. **REST Scoring Fallback:** If a network drop interrupts the WebSocket during session conclusion, the frontend seamlessly transitions to `POST /api/session/:id/end` over HTTP, scoring whatever turns and tells were recorded.

---

## Repository Layout

```
negotiation-dojo/
├── .github/workflows/
│   ├── ci.yml                     # GitHub Actions CI: runs 63 tests & build on push
│   └── keep-warm.yml              # Scheduled external keep-warm runner for backend
├── backend/
│   ├── src/
│   │   ├── server.js              # Express REST API & WebSocket server
│   │   ├── voiceAgentSession.js   # Dual-leg AssemblyAI coordinator (Voice Agent + STT v3)
│   │   ├── cron/keepAlive.js      # Anti-spin-down background service
│   │   ├── personas/              # Alex Chen hiring manager system prompts
│   │   ├── scoring/               # tellDetection.js & deterministic scoreSession.js
│   │   ├── store/sessionStore.js  # Thread-safe in-memory store with disk mirror
│   │   └── tools/                 # logNegotiationMove tool definition & handler
│   ├── test/                      # 63 unit, integration, and full-stack tests
│   └── package.json
├── frontend/
│   ├── public/config.js           # Runtime frontend configuration for zero-rebuild deploys
│   ├── src/
│   │   ├── screens/               # SetupScreen, LiveSessionScreen, ScorecardScreen
│   │   ├── components/            # LiveTranscript, MoveTimeline, TraceStrip
│   │   ├── lib/                   # Web Audio Worklet capture/playback & socket client
│   │   └── styles.css             # Black Box Flight Recorder & Manila Dossier styling
│   ├── package.json
│   └── vite.config.js
├── docs/
│   └── ARCHITECTURE.md            # Canonical technical specification & architecture
├── render.yaml                    # Infrastructure-as-code Render Blueprint
└── LICENSE                        # MIT License
```

---

## License

MIT License. Copyright (c) 2026 sumitagg24.
