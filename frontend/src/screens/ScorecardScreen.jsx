/**
 * Spec C.4 -- renders the ScorecardObject in exactly this order:
 *   1. score header   2. what you did well   3. where you gave away leverage
 *   4. your tells     5. next time           6. try again
 *
 * Part F: empty logs are first class. went_well and tells may be empty and
 * biggest_leverage_loss may be null -- all three render a real empty state
 * rather than a blank card.
 *
 * BLACK BOX skin: the scorecard is the dossier pulled from the recorder --
 * a typed flight-record review with parameter rulers, an exceedance table,
 * a grease-pencil circled probable cause, and rubber stamps. Orange is used
 * only as stamp FILL; stamp text/borders are Ribbon Ink (contrast on paper).
 */

import { useState, useCallback } from "react";
import { copyScorecardText, downloadScorecardReport } from "../lib/scorecardCopy.js";

const TELL_PARAMS = {
  hesitation: "PAUSE DURATION",
  retraction: "UTTERANCE REVISION",
  pace_spike: "SPEECH RATE",
  mumbled_number: "SPEECH CLARITY",
};

const PARAM_DEFS = [
  { key: "anchorQuality", label: "ANCHOR QUALITY", invert: false },
  { key: "reciprocityRatio", label: "RECIPROCITY", invert: false },
  { key: "tellDensity", label: "TELL DISCIPLINE", invert: true },
  { key: "finalOutcomeRatio", label: "FINAL OUTCOME", invert: false },
];

const CELLS = 12;

function clamp01(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

/** Wraps spoken numbers in a wavy red underline, like an investigator's pen. */
function MarkedQuote({ text }) {
  if (!text) return null;
  const parts = String(text).split(/(\$?\d[\d,]*(?:\.\d+)?k?)/gi);
  return (
    <span className="xtable__quote">
      {parts.map((part, index) =>
        /^\$?\d[\d,]*(?:\.\d+)?k?$/i.test(part) ? <em key={index}>{part}</em> : part,
      )}
    </span>
  );
}

function ParameterRuler({ label, ratio, reached }) {
  const filled = reached ? Math.round((ratio ?? 0) * CELLS) : 0;
  return (
    <div className="param">
      <div className="param__label">
        <span>{label}</span>
        <span className="param__value">
          {reached ? `${Math.round((ratio ?? 0) * 100)}` : "—"}
        </span>
      </div>
      <div className="param__ruler" role="img" aria-label={`${label}: ${reached ? Math.round((ratio ?? 0) * 100) + " percent" : "not reached"}`}>
        {Array.from({ length: CELLS }, (_, index) => (
          <span
            key={index}
            className={`param__cell${index < filled ? " param__cell--fill" : " param__cell--void"}`}
          />
        ))}
      </div>
    </div>
  );
}

export default function ScorecardScreen({ scorecard, sessionId, onTryAgain }) {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  const handleCopy = useCallback(() => {
    copyScorecardText(scorecard, sessionId).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [scorecard, sessionId]);

  const handleDownload = useCallback(() => {
    const ok = downloadScorecardReport(scorecard, sessionId);
    if (ok) {
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 2000);
    }
  }, [scorecard, sessionId]);

  if (!scorecard) {
    return (
      <div className="dossier-wrap">
        <div className="dossier">
          <div className="dossier__tab">FLIGHT RECORD REVIEW</div>
          <div className="dossier__sheet">
            <div className="dossier__empty">
              No report came back for that session. The recorder holds nothing without a session.
            </div>
          </div>
          <div className="dossier__footer">
            <button className="btn" type="button" onClick={onTryAgain}>
              New recording
            </button>
          </div>
        </div>
      </div>
    );
  }

  const wentWell = Array.isArray(scorecard.went_well) ? scorecard.went_well : [];
  const tells = Array.isArray(scorecard.tells) ? scorecard.tells : [];
  const loss = scorecard.biggest_leverage_loss || null;
  const score = scorecard.final_score;
  const subs = scorecard.sub_scores || {};
  const outcomeReached = typeof subs.finalOutcomeRatio === "number" && Number.isFinite(subs.finalOutcomeRatio);
  const reviewed = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" }).toUpperCase();

  return (
    <div className="dossier-wrap">
      <div className="dossier">
        <div className="dossier__tab">FLIGHT RECORD REVIEW · {reviewed}</div>

        <div className="dossier__seal tape ink-in" aria-hidden="true">
          <span className="folder__seal-text">RECORDED DATA · REVIEW COPY · RECORDED DATA</span>
        </div>

        <div className="dossier__sheet" id="operator-review">
          {/* 1. Document head + verdict ----------------------------------- */}
          <header className="doc-head">
            <div>
              <p className="doc-head__eyebrow">NEGOTIATION DOJO · RECORDED SESSION REVIEW</p>
              <h1 className="doc-head__title">Operator Review</h1>
              <p className="doc-head__meta">
                {scorecard.narrative_source === "fallback"
                  ? "Deterministic scoring · template findings (LLM narrative unavailable)."
                  : "Deterministic scoring · findings written from your session log."}
              </p>
            </div>
          </header>

          <div className="verdict">
            <div className="verdict__score ink-in ink-in--1">
              {score}
              <small> /100</small>
            </div>
            <div className="verdict__lines ink-in ink-in--2">
              <p className="verdict__line">
                <strong>READS:</strong> {scorecard.score_label}
              </p>
              <p className="verdict__line">
                <strong>METHOD:</strong> parameter review against the operator&rsquo;s own session
                baseline — not a fixed standard.
              </p>
              {outcomeReached ? (
                <p className="verdict__line">
                  <strong>OUTCOME:</strong> settled at {Math.round(subs.finalOutcomeRatio * 100)}% of
                  the operator&rsquo;s target.
                </p>
              ) : (
                <p className="verdict__line">
                  <strong>OUTCOME:</strong> no settlement reached on the record.
                </p>
              )}
            </div>
            <div className="ink-in ink-in--3">
              {outcomeReached ? (
                <span className="stamp stamp--small stamp-in">
                  OUTCOME {Math.round(subs.finalOutcomeRatio * 100)}%
                </span>
              ) : (
                <span className="stamp stamp--small stamp-in">OUTCOME NOT REACHED</span>
              )}
            </div>
          </div>

          {/* 2. Parameter review ------------------------------------------ */}
          <section className="doc-section">
            <div className="doc-section__head">
              <h2 className="doc-section__title">Parameter review</h2>
              <span className="doc-section__note">pen-plotted against session baseline</span>
            </div>
            <div className="param-grid">
              {PARAM_DEFS.map((def) => {
                const raw = subs[def.key];
                const reached = raw !== null && raw !== undefined && raw !== "" ? true : false;
                const ratio = clamp01(def.invert ? (typeof raw === "number" ? 1 - raw : 0) : raw);
                return (
                  <ParameterRuler
                    key={def.key}
                    label={def.label}
                    ratio={ratio}
                    reached={reached && ratio !== null}
                  />
                );
              })}
            </div>
          </section>

          {/* 3. What you did well ----------------------------------------- */}
          <section className="doc-section">
            <div className="doc-section__head">
              <h2 className="doc-section__title">Satisfactory performance</h2>
              <span className="doc-section__note">moments where you held your ground</span>
            </div>
            {wentWell.length === 0 ? (
              <div className="dossier__empty">
                Nothing logged. The conversation did not get far enough for a move to land.
              </div>
            ) : (
              wentWell.map((entry, index) => (
                <div className="sat-row ink-in" key={`well-${index}`}>
                  <div className="sat-row__body">
                    <p className="sat-row__quote">
                      &ldquo;<MarkedQuote text={entry.quote} />&rdquo;
                    </p>
                    <p className="sat-row__note">{entry.note}</p>
                  </div>
                  <span className="stamp stamp--small">SATISFACTORY</span>
                </div>
              ))
            )}
          </section>

          {/* 4. Parameter exceedances (tells) ------------------------------ */}
          <section className="doc-section">
            <div className="doc-section__head">
              <h2 className="doc-section__title">Parameter exceedances</h2>
              <span className="doc-section__note">small signals in how you said it</span>
            </div>
            {tells.length === 0 ? (
              <div className="dossier__empty">
                No exceedances recorded. The operator&rsquo;s delivery stayed inside baseline on every
                parameter — that is exactly the goal.
              </div>
            ) : (
              <div className="xtable-wrap">
                <table className="xtable">
                  <thead>
                    <tr>
                      <th className="xtable__th-code">Ex</th>
                      <th className="xtable__th-param">Parameter</th>
                      <th>As spoken</th>
                      <th>Finding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tells.map((tell, index) => (
                      <tr key={`tell-${index}`}>
                        <td className="xtable__code">{String.fromCharCode(65 + index)}</td>
                        <td className="xtable__param">{TELL_PARAMS[tell.type] || (tell.type || "").toUpperCase()}</td>
                        <td className="xtable__spoken">
                          {tell.quote ? (
                            <MarkedQuote text={tell.quote} />
                          ) : (
                            <span className="doc-section__note">—</span>
                          )}
                        </td>
                        <td className="xtable__note">{tell.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 5. Probable cause --------------------------------------------- */}
          <section className="doc-section">
            <div className="doc-section__head">
              <h2 className="doc-section__title">Probable cause</h2>
              <span className="doc-section__note">the single most expensive moment of the call</span>
            </div>
            {loss ? (
              <div className="cause ink-in ink-in--3">
                <p className="cause__quote">
                  &ldquo;<MarkedQuote text={loss.quote} />&rdquo;
                </p>
                <p className="cause__factor">
                  <strong>FINDING:</strong> {loss.note}
                </p>
              </div>
            ) : (
              <div className="dossier__empty">
                Not enough happened in this session to locate a leverage loss. Engage more next time
                and the recorder will find one.
              </div>
            )}
          </section>

          {/* 6. Recommendation --------------------------------------------- */}
          <section className="doc-section">
            <div className="doc-section__head">
              <h2 className="doc-section__title">Recommendation</h2>
              <span className="doc-section__note">one change. nothing else.</span>
            </div>
            <div className="reco">
              <span className="reco__docket">A-26-{String(Math.max(0, score)).padStart(2, "0")}</span>
              <p className="reco__text ink-in ink-in--4">{scorecard.next_time_instruction}</p>
            </div>
          </section>
        </div>

        <div className="dossier__footer">
          <span className="mono-label">End of report · recorder retains full audio parameters</span>
          <div className="dossier__footer-actions">
            <button className="btn btn--ghost" type="button" onClick={handleCopy}>
              {copied ? "Copied to clipboard!" : "Copy report"}
            </button>
            <button className="btn btn--ghost" type="button" onClick={handleDownload}>
              {downloaded ? "Report downloaded!" : "Download report"}
            </button>
            <button className="btn" type="button" onClick={onTryAgain}>
              New recording
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
