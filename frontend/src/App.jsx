import { useCallback, useState } from "react";

import SetupScreen from "./screens/SetupScreen.jsx";
import LiveSessionScreen from "./screens/LiveSessionScreen.jsx";
import ScorecardScreen from "./screens/ScorecardScreen.jsx";
import { copyScorecardText, downloadScorecardReport } from "./lib/scorecardCopy.js";

/**
 * Spec C.1 -- three states only. No routing library; a single useState deciding
 * which screen renders is the right scope here.
 *
 * BLACK BOX skin: setup + scorecard are the paper world (manila dossier); the
 * live screen switches the app onto the instrument face (charcoal). The two
 * material worlds never mix on one screen.
 */
const SAMPLE_SCORECARD = {
  final_score: 82,
  score_label: "COMPETENT NEGOTIATION",
  sub_scores: {
    anchorQuality: 0.85,
    reciprocityRatio: 0.75,
    tellDensity: 0.2,
    finalOutcomeRatio: 0.95,
  },
  went_well: [
    { quote: "I was looking for $105,000 based on market research.", note: "Anchored above target early." },
  ],
  biggest_leverage_loss: {
    quote: "Well, I could probably do $92,000 if needed.",
    note: "Premature concession before hearing counter-offer.",
  },
  tells: [
    { type: "hesitation", quote: "I was thinking around... $95,000", note: "1.4s silence before stating number" },
    { type: "pace_spike", quote: "Yes that sounds fine to me", note: "Speech rate jumped 40% above baseline" },
  ],
  next_time_instruction: "Anchor high and hold through the silence without conceding early.",
  narrative_source: "llm",
};

export default function App() {
  const queryScreen = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("screen") : null;
  const [screen, setScreen] = useState(queryScreen === "live" || queryScreen === "scorecard" ? queryScreen : "setup");
  const [session, setSession] = useState(queryScreen === "live" ? { sessionId: "sess_demo1234", wsPath: "/ws/session/sess_demo1234" } : null);
  const [scorecard, setScorecard] = useState(queryScreen === "scorecard" ? SAMPLE_SCORECARD : null);
  const [headerCopied, setHeaderCopied] = useState(false);
  const [headerDownloaded, setHeaderDownloaded] = useState(false);

  const handleSessionStart = useCallback((sessionId, wsPath) => {
    setSession({ sessionId, wsPath });
    setScreen("live");
  }, []);

  const handleSessionEnd = useCallback((result) => {
    setScorecard(result);
    setScreen("scorecard");
  }, []);

  const handleTryAgain = useCallback(() => {
    setSession(null);
    setScorecard(null);
    setScreen("setup");
    if (typeof window !== "undefined" && window.location.search) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const handleHeaderCopy = useCallback(() => {
    copyScorecardText(scorecard, session?.sessionId).catch(() => {});
    setHeaderCopied(true);
    setTimeout(() => setHeaderCopied(false), 2000);
  }, [scorecard, session?.sessionId]);

  const handleHeaderDownload = useCallback(() => {
    const ok = downloadScorecardReport(scorecard, session?.sessionId);
    if (ok) {
      setHeaderDownloaded(true);
      setTimeout(() => setHeaderDownloaded(false), 2000);
    }
  }, [scorecard, session?.sessionId]);

  const handleScrollToReview = useCallback(() => {
    const el = document.getElementById("operator-review") || document.querySelector(".dossier__sheet");
    el?.scrollIntoView({ behavior: "smooth" });
  }, []);

  return (
    <div className={`app${screen === "live" ? " app--instrument" : ""}`}>
      <header className="app__header">
        <div
          className="brand"
          onClick={screen === "scorecard" ? handleTryAgain : undefined}
          style={{ cursor: screen === "scorecard" ? "pointer" : "default" }}
          title={screen === "scorecard" ? "Back to Setup" : undefined}
        >
          <span className="brand__mark">Negotiation</span>
          <span className="brand__name">Dojo</span>
        </div>
        {screen === "live" && (
          <div className="status-label status-label--header" aria-label="Recorder open">
            <span className="status-label__dot status-label__dot--header" aria-hidden="true" />
            <span>Recorder open</span>
          </div>
        )}
        {screen === "scorecard" && (
          <div className="header-actions">
            <button
              type="button"
              className="btn-header"
              onClick={handleScrollToReview}
              title="Review session findings"
            >
              Review
            </button>
            <button
              type="button"
              className="btn-header btn-header--copy"
              onClick={handleHeaderCopy}
              title="Copy scorecard review to clipboard"
            >
              {headerCopied ? "Copied!" : "Copy"}
            </button>
            <button
              type="button"
              className="btn-header btn-header--download"
              onClick={handleHeaderDownload}
              title="Download dossier report"
            >
              {headerDownloaded ? "Downloaded!" : "Download"}
            </button>
          </div>
        )}
      </header>

      <div className="app__body">
        {screen === "setup" && <SetupScreen onSessionStart={handleSessionStart} />}
        {screen === "live" && (
          <LiveSessionScreen
            sessionId={session?.sessionId}
            wsPath={session?.wsPath}
            onSessionEnd={handleSessionEnd}
            onBackToSetup={handleTryAgain}
          />
        )}
        {screen === "scorecard" && (
          <ScorecardScreen
            scorecard={scorecard}
            sessionId={session?.sessionId}
            onTryAgain={handleTryAgain}
          />
        )}
      </div>
    </div>
  );
}
