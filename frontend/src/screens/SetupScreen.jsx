import { useState } from "react";

import { backendUrl } from "../lib/config.js";

/**
 * Spec C.2 -- one form, four fields, one button.
 * Part F: a failed connection must show an inline error with a Retry button and
 * must NOT transition to the live screen.
 */


export default function SetupScreen({ onSessionStart }) {
  const [target, setTarget] = useState("");
  const [walkaway, setWalkaway] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [roleTitle, setRoleTitle] = useState("");

  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function validate() {
    const next = {};
    const targetValue = Number(target);
    const walkawayValue = Number(walkaway);

    if (!target.trim()) next.target = "Enter the number you actually want.";
    else if (!Number.isFinite(targetValue) || targetValue <= 0) next.target = "Enter a salary above zero.";

    if (!walkaway.trim()) next.walkaway = "Enter the number you would walk away at.";
    else if (!Number.isFinite(walkawayValue) || walkawayValue <= 0) next.walkaway = "Enter a salary above zero.";
    else if (Number.isFinite(targetValue) && walkawayValue >= targetValue) {
      next.walkaway = "Your walk-away number must be below your target.";
    }

    return next;
  }

  async function startSession() {
    setSubmitting(true);
    setServerError(null);

    try {
      const response = await fetch(`${backendUrl()}/api/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateTargetSalary: Number(target),
          candidateWalkaway: Number(walkaway),
          companyName: companyName.trim() || undefined,
          roleTitle: roleTitle.trim() || undefined,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        setServerError(data.message || `Could not start the session (HTTP ${response.status}).`);
        return;
      }

      onSessionStart(data.sessionId, data.wsPath);
    } catch (err) {
      setServerError(
        `Could not reach the backend at ${backendUrl()}. Is it running? (${err.message})`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    startSession();
  }

  return (
    <div className="screen--center">
      <div className="setup">
        <div className="setup__intro">
          <h1 className="setup__title">Practice the conversation that pays you.</h1>
          <p className="setup__subtitle">
            You have a verbal offer. Alex Chen, a hiring manager, has a number in mind. Talk him up —
            then get scored on your moves, your tells, and the money you left behind.
          </p>
        </div>

        <form className="panel setup__card" onSubmit={handleSubmit} noValidate>
          <div className="setup__row">
            <div className={`field${errors.target ? " field--invalid" : ""}`}>
              <label className="field__label" htmlFor="target">
                Target salary
              </label>
              <input
                id="target"
                className="field__input"
                type="number"
                inputMode="numeric"
                min="1"
                placeholder="120000"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                disabled={submitting}
              />
              {errors.target ? (
                <p className="field__error">{errors.target}</p>
              ) : (
                <p className="field__hint">What you actually want to walk away with.</p>
              )}
            </div>

            <div className={`field${errors.walkaway ? " field--invalid" : ""}`}>
              <label className="field__label" htmlFor="walkaway">
                Walk-away number
              </label>
              <input
                id="walkaway"
                className="field__input"
                type="number"
                inputMode="numeric"
                min="1"
                placeholder="105000"
                value={walkaway}
                onChange={(event) => setWalkaway(event.target.value)}
                disabled={submitting}
              />
              {errors.walkaway ? (
                <p className="field__error">{errors.walkaway}</p>
              ) : (
                <p className="field__hint">Below your target. Alex never sees either number.</p>
              )}
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="company">
              Company name <span style={{ color: "var(--text-faint)" }}>(optional)</span>
            </label>
            <input
              id="company"
              className="field__input"
              type="text"
              placeholder="Northbeam Analytics (default)"
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label className="field__label" htmlFor="role">
              Role title <span style={{ color: "var(--text-faint)" }}>(optional)</span>
            </label>
            <input
              id="role"
              className="field__input"
              type="text"
              placeholder="Senior Software Engineer (default)"
              value={roleTitle}
              onChange={(event) => setRoleTitle(event.target.value)}
              disabled={submitting}
            />
          </div>

          {serverError && (
            <div className="banner banner--error" style={{ marginTop: 20 }}>
              <span>{serverError}</span>
              <button type="button" className="btn btn--ghost" onClick={startSession} disabled={submitting}>
                Retry
              </button>
            </div>
          )}

          <div className="setup__actions">
            <button className="btn btn--primary btn--block" type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Connecting to Alex...
                </>
              ) : (
                "Start Negotiation"
              )}
            </button>
          </div>

          <p className="setup__note">
            You will need a microphone. Headphones are strongly recommended so Alex does not hear
            himself through your speakers.
          </p>
        </form>
      </div>
    </div>
  );
}
