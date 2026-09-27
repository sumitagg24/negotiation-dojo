# Negotiation Dojo

A live voice salary-negotiation trainer. You get a verbal offer, you talk a realistic (moderately
tough) hiring manager up, and then you get a coaching report on your moves, your tells, and the
money you left on the table.

Built on the [AssemblyAI Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)
(topics: `docs/ARCHITECTURE.md`).

---

## Quickstart (fresh clone)

```bash
git clone <this repo>
cd negotiation-dojo

# 1. Backend
cd backend
npm install
cp .env.example .env      # then paste your ASSEMBLYAI_API_KEY into .env
npm run dev               # http://localhost:8080

# 2. Frontend (second terminal)
cd frontend
npm install
cp .env.example .env      # defaults already point at localhost:8080
npm run dev               # http://localhost:5173
```

Open <http://localhost:5173>, enter a target salary and a walk-away number, click **Start
Negotiation**, and talk.

**Use headphones.** Without them Alex hears himself through your speakers and interrupts himself.

That is the entire setup. No other services, no database, no second API key.

### Environment variables

Only one is required, and it lives in `backend/.env`:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ASSEMBLYAI_API_KEY` | **yes** | — | Voice agent, word-level STT leg, and the LLM Gateway for the scorecard narrative |
| `PORT` | no | `8080` | Backend HTTP + WebSocket port |
| `CORS_ORIGIN` | no | `http://localhost:5173` | Allowed browser origin |
| `SESSION_STORE_PATH` | no | `./data/sessions.json` | Crash-safety mirror of sessions |
| `ENABLE_TELL_STT_LEG` | no | `true` | Word-level tell detection (see note below) |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | no | AssemblyAI LLM Gateway | Bring your own OpenAI-compatible model for the narrative |

`frontend/.env` only needs the two defaults: `VITE_BACKEND_URL` and `VITE_BACKEND_WS_URL`.

If `ASSEMBLYAI_API_KEY` is set but no LLM key is configured separately, scorecard narratives are
written by the AssemblyAI LLM Gateway using that same key. If no key is available at all, scoring
still works — the deterministic sub-scores are rendered with a built-in narrative template, and the
scorecard says so.

**The frontend never holds an AssemblyAI key.** Every AssemblyAI call is made from the backend.

---

## How it works

```
Browser ──mic (PCM16 24kHz, base64)──► Backend ──► AssemblyAI Voice Agent API   (conversation, TTS, tools)
                                            └──► AssemblyAI Streaming STT v3   (word timings, for tells)
       ◄── transcript / audio / tells / moves / scorecard ──┘
```

Three things happen on every turn:

1. **Moves** — Alex calls a `log_negotiation_move` tool after each of your turns. The backend stores
   it and pushes it to the move timeline.
2. **Tells** — every completed user utterance is run through four detectors (hesitation before a
   number, retraction of a number, pace spike against *your own* rolling baseline, mumbled number).
   A detected tell flashes a passive indicator; it never interrupts the conversation.
3. **Scoring** — on end, sub-scores are computed by a fixed weighted formula and the LLM writes only
   the prose.

### The score is not a black box

```
final_score = 0.30·anchor_quality
            + 0.30·reciprocity_ratio
            + 0.25·(1 − tell_density)
            + 0.15·outcome_score
```

`final_score` is **always** computed by that formula in `scoreSession.js`. The LLM writes the
coaching notes and can never change the number — whatever it returns is discarded and overwritten.
The sub-scores ship to the frontend alongside the scorecard as `sub_scores`.

---

## Project layout

```
negotiation-dojo/
├── backend/
│   ├── test/                            48 tests, `npm test`
│   ├── src/
│   │   ├── server.js                    REST (B.1) + WebSocket protocol (B.8)
│   │   ├── voiceAgentSession.js         both AssemblyAI legs -> the B.2 callback contract
│   │   ├── personas/hiringManager.js    THE prompt, and the only place it lives
│   │   ├── tools/logNegotiationMove.js  tool schema (D.2) + handler (B.4)
│   │   ├── scoring/tellDetection.js     four detectors + baseline stats (B.5)
│   │   ├── scoring/scoreSession.js      deterministic score, narrative, LLM client
│   │   └── store/sessionStore.js        in-memory + JSON mirror (B.7)
├── frontend/
│   └── src/
│       ├── App.jsx                      three-screen state machine (C.1)
│       ├── screens/                     Setup, LiveSession, Scorecard (C.2-C.4)
│       ├── components/                  LiveTranscript, TellIndicator, MoveTimeline (C.5)
│       └── lib/                         socket.js (C.6), audio.js (capture + playback)
└── docs/ARCHITECTURE.md
```

---

## Verification status

`cd backend && npm test` runs **48 tests**, all passing:

- **Tell detection (17 tests)** — all four detectors fire correctly on scripted utterances that
  trigger each one, and stay silent on clean ones. This satisfies acceptance row 4, which asked for
  at least 3 of 4.
- **Scoring (23 tests)** — the weighted formula, the deterministic-score rule (an LLM claiming
  `final_score: 999` is ignored), the malformed-JSON retry, the fallback narrative, and the
  empty-session case.
- **Session contract (7 tests)** — `VoiceAgentSession` driven against a mock AssemblyAI server:
  handshake payload, transcript mapping, tool-call round trip, barge-in flush, word-level turns
  reaching the detectors, and clean teardown.
- **Full stack (1 test)** — the real `server.js` driven over real HTTP and WebSocket against a mock
  AssemblyAI: `POST /start` → `session_ready` → audio → `tool.call` → `move_logged` → word-level turn
  → `tell_detected` → `end_session` → `scorecard_ready` (score 55, computed by the formula), then
  `GET /scorecard`. It also proves an LLM-invented `final_score: 999` is discarded and that unknown
  sessions are refused on both surfaces.

`cd frontend && npm run build` compiles clean.

**What is not verified:** the real audio round trip. That needs a live `ASSEMBLYAI_API_KEY`, so the
actual speech-to-speech path (mic → AssemblyAI → Alex's voice) has only been exercised against the
mock. Everything either side of it is tested.

---

## Deployment

Two hosts, because the backend must keep a process alive: the browser holds a long-lived WebSocket
to it for the whole negotiation, and Vercel's serverless functions cannot do that. Frontend on
Vercel, backend on Render (or Railway / Fly.io).

### 1. Backend → Render

`render.yaml` in the repo root is a Render Blueprint: root directory, build and start commands,
health-check path and every non-secret env var are already configured.

1. Render dashboard → **New** → **Blueprint** → pick this repo.
2. Render reads `render.yaml` and prompts for **`ASSEMBLYAI_API_KEY`** (declared `sync: false`, so its
   value is never stored in git). Paste your key.
3. Deploy, then confirm `GET /api/health` returns `{"status":"ok"}` over HTTPS.

Your backend URL is then `https://<service>.onrender.com`, with `wss://` for the WebSocket.

> **Free plan warning.** Free instances spin down after ~15 minutes idle and take 30–60s to cold
> start, with a monthly hour cap. A cold start mid-demo looks like a hang. Switch `plan:` in
> `render.yaml` to `starter` for demo day, or ping `/api/health` every few minutes to keep it warm.

### 2. Point the frontend at it

The Vercel project (`negotiation-dojo`) already auto-deploys on every push to `main`. Choose one:

- **Edit `frontend/public/config.js`** — recommended: no dashboard access and no build flags.
  ```js
  window.__NEGOTIATION_DOJO__ = {
    backendUrl: "https://<your-service>.onrender.com",
    backendWsUrl: "wss://<your-service>.onrender.com",
  };
  ```
- Or set `VITE_BACKEND_URL` / `VITE_BACKEND_WS_URL` in the Vercel project's environment variables and
  redeploy. These are inlined at build time, so a change needs a rebuild.

`frontend/public/config.js` wins if both are set. Note the protocol changes when deployed:
`https://` for REST and `wss://` for the WebSocket, both on the same host.

### 3. CORS

`CORS_ORIGIN` accepts a **comma-separated list**, and each entry can be an exact origin or a wildcard
subdomain pattern (`https://*.vercel.app`). One frontend is served from several hosts at once — local
dev, the production alias, the per-branch alias, and a fresh unique URL for every preview deployment
— so a single origin string silently breaks all but one of them, and the browser reports it as a
generic network failure rather than a CORS rejection. A rejected origin logs its own fix:

```
[cors] blocked origin "https://evil.example.com". CORS_ORIGIN allows: http://localhost:5173, https://*.vercel.app
```

### Deployment checklist

- [ ] `GET /api/health` returns 200 over HTTPS on the backend
- [ ] `frontend/public/config.js` (or the Vercel env vars) points at that backend
- [ ] Open the Vercel URL in an incognito window, allow the mic, complete one full session
- [ ] `CORS_ORIGIN` includes the exact Vercel URL being submitted

---

## Deviations from the original spec

`negotiation_dojo_full_spec.md` told us to confirm the AssemblyAI contracts against the live docs and
adapt field names where they differed. Several differences turned out to be material. They are all
listed with reasoning in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the headlines:

1. **The real event names differ from the spec's target contract** (`reply.audio` not `agent_audio`,
   `tool.call` not `tool_use`, `session.end` required for teardown, and so on).
2. **`transcript.user` carries no word timings and no confidence**, so the four tell detectors had no
   input on the Voice Agent API alone. A parallel word-level Streaming STT leg was added — inside
   `voiceAgentSession.js`, so the file tree stays as specified — and is what makes acceptance row 4
   achievable.
3. **The candidate's target and walk-away numbers are deliberately not interpolated into Alex's
   system prompt.** Spec B.3 listed them as template variables, but the D.1 template does not use
   them, and putting them in Alex's prompt would let the hiring manager read your hand.
4. Two additive protocol/payload fields (`agent_audio_flush`, `narrative_source`) that the real API's
   barge-in semantics and part F's fallback path respectively require.
5. A few standard scaffold files the spec's file tree did not name (`index.html`, `vite.config.js`,
   `styles.css`, `lib/audio.js`, tests) and three small bug fixes to the specified logic — all
   documented.
