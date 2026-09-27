/**
 * Helper to format, copy, and download scorecard dossier review.
 */

export function getScorecardSummaryText(scorecard, sessionId) {
  if (!scorecard) return "";
  const sub = scorecard.sub_scores || {};
  const reviewed = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).toUpperCase();
  const idStr = sessionId ? ` · SESS ${String(sessionId).slice(-6).toUpperCase()}` : "";

  const lines = [
    "================================================================================",
    "                    NEGOTIATION DOJO — OPERATOR REVIEW",
    "                        FLIGHT RECORD REVIEW DOSSIER",
    `DATE: ${reviewed}${idStr}`,
    "================================================================================",
    `SCORE: ${scorecard.final_score}/100 · ${scorecard.score_label || ""}`,
    "METHOD: Parameter review against the operator's own session baseline",
    `OUTCOME: ${
      sub.finalOutcomeRatio != null
        ? `${Math.round(sub.finalOutcomeRatio * 100)}% of target`
        : "No settlement reached on record"
    }`,
    "",
    "--------------------------------------------------------------------------------",
    "PARAMETER REVIEW (PEN-PLOTTED RULERS):",
    "--------------------------------------------------------------------------------",
    `• Anchor Quality:   ${sub.anchorQuality != null ? `${Math.round(sub.anchorQuality * 100)}%` : "—"}`,
    `• Reciprocity:      ${sub.reciprocityRatio != null ? `${Math.round(sub.reciprocityRatio * 100)}%` : "—"}`,
    `• Tell Discipline:  ${sub.tellDensity != null ? `${Math.round((1 - sub.tellDensity) * 100)}%` : "—"}`,
    `• Final Outcome:    ${sub.finalOutcomeRatio != null ? `${Math.round(sub.finalOutcomeRatio * 100)}%` : "—"}`,
    "",
  ];

  if (scorecard.went_well?.length) {
    lines.push("--------------------------------------------------------------------------------");
    lines.push("SATISFACTORY PERFORMANCE (MOMENTS WHERE YOU HELD GROUND):");
    lines.push("--------------------------------------------------------------------------------");
    scorecard.went_well.forEach((item) => {
      lines.push(`• "${item.quote}": ${item.note}`);
    });
    lines.push("");
  } else {
    lines.push("--------------------------------------------------------------------------------");
    lines.push("SATISFACTORY PERFORMANCE:");
    lines.push("--------------------------------------------------------------------------------");
    lines.push("• Nothing logged. The conversation did not get far enough for a move to land.");
    lines.push("");
  }

  if (scorecard.tells?.length) {
    lines.push("--------------------------------------------------------------------------------");
    lines.push("PARAMETER EXCEEDANCES (SMALL SIGNALS IN HOW YOU SAID IT):");
    lines.push("--------------------------------------------------------------------------------");
    scorecard.tells.forEach((t, i) => {
      const code = String.fromCharCode(65 + i);
      lines.push(`• [${code}] [${(t.type || "").toUpperCase()}] "${t.quote || "—"}": ${t.note || ""}`);
    });
    lines.push("");
  } else {
    lines.push("--------------------------------------------------------------------------------");
    lines.push("PARAMETER EXCEEDANCES (TELLS):");
    lines.push("--------------------------------------------------------------------------------");
    lines.push("• No exceedances recorded. Delivery stayed within baseline on every parameter.");
    lines.push("");
  }

  if (scorecard.biggest_leverage_loss) {
    lines.push("--------------------------------------------------------------------------------");
    lines.push("PROBABLE CAUSE (MOST EXPENSIVE MOMENT / LEVERAGE LOSS):");
    lines.push("--------------------------------------------------------------------------------");
    lines.push(`• Spoken: "${scorecard.biggest_leverage_loss.quote}"`);
    lines.push(`• Finding: ${scorecard.biggest_leverage_loss.note}`);
    lines.push("");
  }

  if (scorecard.next_time_instruction) {
    lines.push("--------------------------------------------------------------------------------");
    lines.push("RECOMMENDATION (TACTICAL DIRECTIVE):");
    lines.push("--------------------------------------------------------------------------------");
    lines.push(`• Docket A-26-${String(Math.max(0, scorecard.final_score || 0)).padStart(2, "0")}: ${scorecard.next_time_instruction}`);
    lines.push("");
  }

  lines.push("================================================================================");
  lines.push("END OF REPORT · Flight recorder retains full audio parameters");
  lines.push("================================================================================");

  return lines.join("\n");
}

export async function copyScorecardText(scorecard, sessionId) {
  const text = getScorecardSummaryText(scorecard, sessionId);
  if (!text) return false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function downloadScorecardReport(scorecard, sessionId) {
  const text = getScorecardSummaryText(scorecard, sessionId);
  if (!text) return false;
  try {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const id = sessionId ? String(sessionId).slice(-6).toUpperCase() : "RECORD";
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `flight-record-review-${id}-${dateStr}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
    return true;
  } catch (err) {
    console.error("Failed to download dossier report:", err);
    return false;
  }
}
