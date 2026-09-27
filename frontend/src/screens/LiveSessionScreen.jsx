import { useEffect, useMemo, useRef, useState } from "react";

import { createSessionSocket } from "../lib/socket.js";
import { createAudioEngine } from "../lib/audio.js";
import LiveTranscript from "../components/LiveTranscript.jsx";
import TellIndicator from "../components/TellIndicator.jsx";
import MoveTimeline from "../components/MoveTimeline.jsx";

/**
 * Spec C.3 -- two columns on desktop, stacked on mobile.
 * Covers part F rows: mic permission denied, connection lost mid-session,
 * scoring failure with a retry, and empty sessions.
 */
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8080";

/** If the socket path never produces a scorecard, fall back to REST. */
const REST_SCORING_FALLBACK_MS = 5000;

export default function LiveSessionScreen({ sessionId, wsPath, onSessionEnd, onBackToSetup }) {
  const [segments, setSegments] = useState([]);
  const [partials, setPartials] = useState({ user: "", agent: "" });
  const [moves, setMoves] = useState([]);
  const [activeTell, setActiveTell] = useState(null);
  const [status, setStatus] = useState("connecting"); // connecting | live | ending | failed
  const [micDenied, setMicDenied] = useState(false);
  const [banner, setBanner] = useState(null);

  const socketRef = useRef(null);
  const engineRef = useRef(null);
  const endedRef = useRef(false);
  const finishedRef = useRef(false);
  const fallbackTimerRef = useRef(null);
  const finishRef = useRef(() => {});

  // ------------------------------------------------------------------ socket
  useEffect(() => {
    if (!wsPath) return undefined;

    const engine = createAudioEngine();
    engineRef.current = engine;

    const complete = (scorecard) => {
      if (finishedRef.current || !scorecard) return;
      finishedRef.current = true;
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
      setStatus("ending");
      try {
        engineRef.current?.stop();
      } catch {
        /* ignore */
      }
      try {
        socketRef.current?.close();
      } catch {
        /* ignore */
      }
      onSessionEnd(scorecard);
    };
    finishRef.current = complete;

    const socket = createSessionSocket(wsPath, {
      onSessionReady: () => setStatus((current) => (current === "connecting" ? "live" : current)),

      onTranscriptPartial: (msg) => setPartials((prev) => ({ ...prev, [msg.speaker]: msg.text || "" })),

      onTranscriptFinal: (msg) => {
        setSegments((prev) => [...prev, { speaker: msg.speaker, text: msg.text || "", isFinal: true }]);
        setPartials((prev) => ({ ...prev, [msg.speaker]: "" }));
      },

      onAgentAudio: (msg) => {
        if (endedRef.current) return;
        engine.playChunk(msg.payload);
      },

      // Barge-in: drop queued agent audio so stale speech does not play over you.
      onAgentAudioFlush: () => engine.flush(),

      onTellDetected: (msg) =>
        setActiveTell({ tellType: msg.tellType, quote: msg.quote, at: Date.now() }),

      onMoveLogged: (msg) => setMoves((prev) => [msg.move, ...prev]),

      onScorecardReady: (msg) => complete(msg.scorecard),

      onError: (msg) => {
        setBanner({ code: msg.code, message: msg.message });
        // A failed scoring pass must release the loading overlay, or the retry
        // button would be trapped underneath it.
        if (msg.code === "SCORING_FAILED") setStatus("failed");
      },
    });

    socketRef.current = socket;

    let cancelled = false;
    (async () => {
      try {
        await engine.startCapture((base64) => socket.sendAudioChunk(base64));
        if (!cancelled) setStatus((current) => (current === "connecting" ? "live" : current));
      } catch (err) {
        if (!cancelled) setMicDenied(true);
      }
    })();

    return () => {
      cancelled = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      try {
        engine.stop();
      } catch {
        /* ignore */
      }
    };
  }, [wsPath, onSessionEnd]);

  // ------------------------------------------------------------------ actions
  async function scoreViaRest() {
    try {
      const response = await fetch(`${BACKEND_URL}/api/session/${sessionId}/end`, { method: "POST" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.scorecard) {
        throw new Error(data.message || `HTTP ${response.status}`);
      }
      finishRef.current(data.scorecard);
    } catch (err) {
      setBanner({ code: "SCORING_FAILED", message: `Scoring failed: ${err.message}` });
      setStatus("failed");
    }
  }

  async function handleEndSession() {
    if (endedRef.current) return;
    endedRef.current = true;
    setStatus("ending");

    // Release the microphone immediately; the conversation is over.
    try {
      engineRef.current?.stop();
    } catch {
      /* ignore */
    }

    const socket = socketRef.current;
    if (socket?.isOpen()) {
      socket.endSession();
      // Belt and braces: if the socket path stalls, score over REST instead.
      fallbackTimerRef.current = setTimeout(scoreViaRest, REST_SCORING_FALLBACK_MS);
    } else {
      // Connection already dropped (part F): score whatever was captured.
      await scoreViaRest();
    }
  }

  function handleBackToSetup() {
    // Stop billing for a session the user is abandoning before it ever began.
    if (sessionId) {
      fetch(`${BACKEND_URL}/api/session/${sessionId}/end`, { method: "POST" }).catch(() => {});
    }
    onBackToSetup?.();
  }

  const renderSegments = useMemo(() => {
    const active = [];
    if (partials.agent?.trim()) active.push({ speaker: "agent", text: partials.agent, isFinal: false });
    if (partials.user?.trim()) active.push({ speaker: "user", text: partials.user, isFinal: false });
    return [...segments, ...active];
  }, [segments, partials]);

  // ------------------------------------------------------------- mic denied
  if (micDenied) {
    return (
      <div className="overlay">
        <h2 className="overlay__title">Microphone access is blocked</h2>
        <p className="overlay__text">
          This drill is a live voice conversation, so it cannot run without your microphone.
        </p>
        <ol className="overlay__steps">
          <li>Click the padlock or camera icon in your browser&rsquo;s address bar.</li>
          <li>Set Microphone to &ldquo;Allow&rdquo;.</li>
          <li>Reload the page and start the negotiation again.</li>
        </ol>
        <button className="btn btn--primary" type="button" onClick={handleBackToSetup}>
          Back to setup
        </button>
      </div>
    );
  }

  return (
    <div className="live">
      <div className="live__grid">
        <div className="live__col">
          <div className="live__colhead">
            <span className="mono-label">Conversation</span>
            <TellIndicator activeTell={activeTell} />
          </div>
          <div className="panel transcript">
            <LiveTranscript segments={renderSegments} />
          </div>
        </div>

        <div className="live__col">
          <div className="live__colhead">
            <span className="mono-label">Move timeline</span>
            <span className="mono-label">{moves.length} logged</span>
          </div>
          <div className="panel" style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <MoveTimeline moves={moves} />
          </div>
        </div>
      </div>

      {banner && (
        <div style={{ padding: "0 28px 12px" }}>
          <div className={`banner ${banner.code === "SCORING_FAILED" ? "banner--error" : "banner--warn"}`}>
            <span>{banner.message}</span>
          </div>
        </div>
      )}

      <div className="live__footer">
        <div className="live__status">
          <span className={`dot${status === "live" ? " dot--live" : ""}`} aria-hidden="true" />
          {status === "connecting" && "Connecting to Alex..."}
          {status === "live" && "Live — speak naturally"}
          {status === "ending" && "Scoring your negotiation..."}
          {status === "failed" && "Scoring failed — you can retry"}
        </div>

        {status === "failed" ? (
          <button className="btn btn--primary" type="button" onClick={scoreViaRest}>
            Retry scoring
          </button>
        ) : (
          <button
            className="btn btn--danger"
            type="button"
            onClick={handleEndSession}
            disabled={status === "ending"}
          >
            End Session
          </button>
        )}
      </div>

      {status === "ending" && (
        <div className="overlay">
          <span className="spinner" style={{ width: 26, height: 26, borderWidth: 3 }} aria-hidden="true" />
          <h2 className="overlay__title">Scoring your negotiation...</h2>
          <p className="overlay__text">
            Reading back every move and every tell. This takes a few seconds.
          </p>
        </div>
      )}
    </div>
  );
}
