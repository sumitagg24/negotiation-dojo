/**
 * Spec C.4 -- renders the ScorecardObject in exactly this order:
 *   1. score header   2. what you did well   3. where you gave away leverage
 *   4. your tells     5. next time           6. try again
 *
 * Part F: empty logs are first class. went_well and tells may be empty and
 * biggest_leverage_loss may be null -- all three render a real empty state
 * rather than a blank card.
 */

const TELL_LABELS = {
  hesitation: "Hesitation",
  retraction: "Retraction",
  pace_spike: "Pace spike",
  mumbled_number: "Mumbled number",
};

export default function ScorecardScreen({ scorecard, onTryAgain }) {
  if (!scorecard) {
    return (
      <div className="scorecard">
        <div className="scorecard__empty">
          No scorecard came back for that session. Start a new negotiation to get a full report.
        </div>
        <div className="scorecard__footer">
          <button className="btn btn--primary" type="button" onClick={onTryAgain}>
            Try Again
          </button>
        </div>
      </div>
    );
  }

  const wentWell = Array.isArray(scorecard.went_well) ? scorecard.went_well : [];
  const tells = Array.isArray(scorecard.tells) ? scorecard.tells : [];
  const loss = scorecard.biggest_leverage_loss || null;
  const score = scorecard.final_score;

  return (
    <div className="scorecard">
      {/* 1. Score header ---------------------------------------------------- */}
      <div className="score-head">
        <div>
          <span className="score-number">{score}</span>
          <span className="score-number__outof"> / 100</span>
        </div>
        <div className="score-label">{scorecard.score_label}</div>
        <div className="score-meta">
          {scorecard.narrative_source === "fallback"
            ? "Deterministic score · coaching notes generated from the weighted sub-scores"
            : "Deterministic score · coaching notes written from your session log"}
        </div>
      </div>

      {/* 2. What you did well ---------------------------------------------- */}
      <section className="section">
        <h2 className="section__title">What you did well</h2>
        <p className="section__hint">Moments where you held your ground.</p>
        {wentWell.length === 0 ? (
          <div className="scorecard__empty">
            Nothing here yet — you did not get far enough into the conversation for a move to land.
          </div>
        ) : (
          wentWell.map((entry, index) => (
            <div className="quote-card" key={`well-${index}`}>
              <p className="quote-card__quote">&ldquo;{entry.quote}&rdquo;</p>
              <p className="quote-card__note">{entry.note}</p>
            </div>
          ))
        )}
      </section>

      {/* 3. Where you gave away leverage ----------------------------------- */}
      <section className="section">
        <h2 className="section__title">Where you gave away leverage</h2>
        <p className="section__hint">The single most expensive moment of the call.</p>
        {loss ? (
          <div className="loss-card">
            <div className="loss-card__label">Biggest leverage loss</div>
            <p className="quote-card__quote">&ldquo;{loss.quote}&rdquo;</p>
            <p className="quote-card__note">{loss.note}</p>
          </div>
        ) : (
          <div className="scorecard__empty">
            Not enough happened in this session to find a leverage loss — try engaging more next time.
          </div>
        )}
      </section>

      {/* 4. Your tells ------------------------------------------------------ */}
      <section className="section">
        <h2 className="section__title">Your tells</h2>
        <p className="section__hint">
          Small signals in how you said it. A hiring manager reads these in real time.
        </p>
        {tells.length === 0 ? (
          <div className="scorecard__empty">
            No tells detected. You delivered your numbers calmly — that is exactly the goal.
          </div>
        ) : (
          tells.map((tell, index) => (
            <div className="tell-card" key={`tell-${index}`}>
              <div className="tell-card__type">{TELL_LABELS[tell.type] || tell.type}</div>
              {tell.quote && <p className="quote-card__quote">&ldquo;{tell.quote}&rdquo;</p>}
              <p className="quote-card__note">{tell.note}</p>
            </div>
          ))
        )}
      </section>

      {/* 5. Next time ------------------------------------------------------- */}
      <section className="section">
        <h2 className="section__title">Next time</h2>
        <p className="section__hint">One thing to change. Nothing else.</p>
        <div className="next-time">
          <div className="mono-label">The takeaway</div>
          <p className="next-time__text">{scorecard.next_time_instruction}</p>
        </div>
      </section>

      {/* 6. Try again ------------------------------------------------------- */}
      <div className="scorecard__footer">
        <button className="btn btn--primary" type="button" onClick={onTryAgain}>
          Try Again
        </button>
      </div>
    </div>
  );
}
