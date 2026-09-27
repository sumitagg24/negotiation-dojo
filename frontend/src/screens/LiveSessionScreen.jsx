import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { backendUrl } from "../lib/config.js";
import { createSessionSocket } from "../lib/socket.js";
import { createAudioEngine } from "../lib/audio.js";
import LiveTranscript from "../components/LiveTranscript.jsx";
import MoveTimeline from "../components/MoveTimeline.jsx";
import TraceStrip from "../components/TraceStrip.jsx";

/**
 * Spec C.3 -- two columns on desktop, stacked on mobile.
 * Covers part F rows: mic permission denied, connection lost mid-session,
 * scoring failure with a retry, and empty sessions.
 *
 * BLACK BOX skin: the screen is the recorder's face during the session --
 * typed voice log, move margin, and the three-trace FDR strip fed by the
 * SAME mic chunks that stream to the backend. Backend tell events snap
 * orange exceedance flags onto the rail. Ending pulls the report from the
 * recorder like a sheet from an envelope.
 */

/** If the socket path never produces a scorecard, fall back to REST. */
const REST_SCORING_FALLBACK_MS = 5000;

const FLAG_LABELS = {
  hesitation: "PAUSE DURATION",
  retraction: "UTTERANCE REVISION",
  pace_spike: "SPEECH RATE",
  mumbled_number: "SPEECH CLARITY",
};

export default function LiveSessionScreen({ sessionId, wsPath, onSessionEnd, onBackToSetup }) {
  const [segments, setSegments] = useState([]);
  const [partials, setPartials] = useState({ user: "", agent: "" });
  const [moves, setMoves] = useState([]);
  const [flags, setFlags] = useState([]);
  const [status, setStatus] = useState("connecting"); // connecting | live | ending | failed
  const [micDenied, setMicDenied] = useState(false);
  const [banner, setBanner] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  const socketRef = useRef(null);
  const engineRef = useRef(null);
  const endedRef = useRef(false);
  const finishedRef = useRef(false);
  const fallbackTimerRef = useRef(null);
  const finishRef = useRef(() => {});
  const traceApiRef = useRef(null);
  const elapsedRef = useRef(0);

  // Recording clock: the strip and the exceedance flags are timestamped
  // against this, so the report can cite "00:47" and mean something.
  useEffect(() => {
    const timer = setInterval(() => {
      elapsedRef.current += 1;
      setElapsed(elapsedRef.current);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const clockLabel = useMemo(() => {
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const seconds = String(elapsed % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }, [elapsed]);

  // Stable bind for the TraceStrip; the strip registers its push/addFlag API.
  const bindTraceApi = useCallback((api) => {
    traceApiRef.current = api;
  }, []);

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

      onTellDetected: (msg) => {
        const param = FLAG_LABELS[msg.tellType] || "PARAMETER";
        const stamp = clockLabelFromSeconds(elapsedRef.current);
        // Rail chip (DOM) + strip mark (canvas): the backend verdict and the
        // client-measured pens read as one instrument. The strip estimates
        // which pen moment the detection refers to; display only.
        setFlags((prev) => [{ label: `${param} · ${stamp}`, at: Date.now() }, ...prev].slice(0, 4));
        traceApiRef.current?.addFlag(param, msg.tellType);
      },

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
        // The same 50 ms chunk goes to the strip (measured) and the backend
        // (scored): one microphone, two records.
        await engine.startCapture((base64) => {
          traceApiRef.current?.pushAudio(base64);
          socket.sendAudioChunk(base64);
        });
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
    // clockLabelFromSeconds is a module function; onSessionEnd is stable.
  }, [wsPath, onSessionEnd]);

  // ------------------------------------------------------------------ actions
  async function scoreViaRest() {
    try {
      const response = await fetch(`${backendUrl()}/api/session/${sessionId}/end`, { method: "POST" });
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
      fetch(`${backendUrl()}/api/session/${sessionId}/end`, { method: "POST" }).catch(() => {});
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
        <h2 className="overlay__title">Recorder cannot open</h2>
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
      {/* ------------------------------------------------------- status bar */}
      <div className="live__statusbar">
        <span className="live__rec">
          <span className="live__rec-dot" aria-hidden="true" />
          Recording {clockLabel}
        </span>
        <span>SESS {String(sessionId || "").slice(-4).toUpperCase() || "----"}</span>
        <span className="live__spacer" />
        <button
          className="btn btn--danger"
          type="button"
          onClick={handleEndSession}
          disabled={status === "ending"}
        >
          Stop recording
        </button>
      </div>

      {/* -------------------------------------------------------- two panes */}
      <div className="live__grid">
        <div className="live__col">
          <div className="live__colhead">
            <span className="live__colhead-title">Voice log — typed record</span>
            {status === "live" ? (
              <span className="status-label status-label--mic">
                <span className="status-label__dot status-label__dot--live" aria-hidden="true" />
                <span>Open mic</span>
              </span>
            ) : (
              <span className="status-label">{status.toUpperCase()}</span>
            )}
          </div>
          <div className="transcript">
            <LiveTranscript segments={renderSegments} />
          </div>
        </div>

        <div className="live__col">
          <div className="live__colhead">
            <span className="live__colhead-title">Move margin</span>
            <span className="status-label">{moves.length} logged</span>
          </div>
          <MoveTimeline moves={moves} />
        </div>
      </div>

      {banner && (
        <div className="live__banner-pad">
          <div className={`banner ${banner.code === "SCORING_FAILED" ? "banner--error" : ""}`}>
            <span>{banner.message}</span>
          </div>
        </div>
      )}

      {/* ------------------------------------------------- telemetry strip */}
      <div className="live__telemetry">
        <div className="fdr__tapeband tape" aria-hidden="true" />
        <TraceStrip bindApi={bindTraceApi} />
        <div className="fdr__rail" aria-live="polite">
          <span className="fdr__rail-label">Parameter exceedances</span>
          {flags.length === 0 ? (
            <span className="fdr__rail-label" style={{ opacity: 0.55 }}>
              — none recorded
            </span>
          ) : (
            flags.map((flag) => (
              <span className="xflag" key={flag.at}>
                {flag.label}
              </span>
            ))
          )}
        </div>
      </div>

      {/* --------------------------------------------------------- footer */}
      <div className="live__footer">
        <div className="live__status">
          <span className={`dot${status === "live" ? " dot--live" : ""}`} aria-hidden="true" />
          {status === "connecting" && "Handshaking with the agent"}
          {status === "live" && "Live — speak naturally"}
          {status === "ending" && "Recorder stopped — reading back the record"}
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
            End session
          </button>
        )}
      </div>

      {/* --------------------------------------------------- ending overlay */}
      {status === "ending" && (
        <div className="overlay">
          <div className="overlay__sheet">
            <span className="stamp stamp--small">RECORDER STOPPED</span>
            <h2 className="overlay__title" style={{ color: "var(--ink)" }}>
              Reading back the record
            </h2>
            <p className="overlay__text" style={{ color: "var(--ink-soft)" }}>
              Stripping the recorder and scoring every move and every exceedance. This takes a few
              seconds.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function clockLabelFromSeconds(total) {
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
