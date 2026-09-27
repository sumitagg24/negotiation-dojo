import { useCallback, useState } from "react";

import SetupScreen from "./screens/SetupScreen.jsx";
import LiveSessionScreen from "./screens/LiveSessionScreen.jsx";
import ScorecardScreen from "./screens/ScorecardScreen.jsx";

/**
 * Spec C.1 -- three states only. No routing library; a single useState deciding
 * which screen renders is the right scope here.
 */
export default function App() {
  const [screen, setScreen] = useState("setup");
  const [session, setSession] = useState(null);
  const [scorecard, setScorecard] = useState(null);

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
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <div className="brand">
          <span className="brand__mark">Negotiation</span>
          <span className="brand__name">Dojo</span>
        </div>
        {screen === "live" && <span className="mono-label">Live session</span>}
        {screen === "scorecard" && <span className="mono-label">Coaching report</span>}
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
        {screen === "scorecard" && <ScorecardScreen scorecard={scorecard} onTryAgain={handleTryAgain} />}
      </div>
    </div>
  );
}
