/**
 * Helper to format and copy scorecard review to clipboard.
 */

export function getScorecardSummaryText(scorecard) {
  if (!scorecard) return "";
  const sub = scorecard.sub_scores || {};
  const lines = [
    "NEGOTIATION DOJO — OPERATOR REVIEW",
    `Score: ${scorecard.final_score}/100 · ${scorecard.score_label || ""}`,
    `Outcome: ${sub.finalOutcomeRatio ? `${Math.round(sub.finalOutcomeRatio * 100)}% of target` : "No settlement reached"}`,
    "",
    "PARAMETER REVIEW:",
    `• Anchor Quality: ${sub.anchorQuality != null ? `${Math.round(sub.anchorQuality * 100)}%` : "—"}`,
    `• Reciprocity: ${sub.reciprocityRatio != null ? `${Math.round(sub.reciprocityRatio * 100)}%` : "—"}`,
    `• Tell Discipline: ${sub.tellDensity != null ? `${Math.round((1 - sub.tellDensity) * 100)}%` : "—"}`,
    "",
  ];

  if (scorecard.went_well?.length) {
    lines.push("SATISFACTORY PERFORMANCE:");
    scorecard.went_well.forEach((item) => {
      lines.push(`• "${item.quote}": ${item.note}`);
    });
    lines.push("");
  }

  if (scorecard.tells?.length) {
    lines.push("PARAMETER EXCEEDANCES (TELLS):");
    scorecard.tells.forEach((t) => {
      lines.push(`• [${t.type?.toUpperCase()}] "${t.quote}": ${t.note}`);
    });
    lines.push("");
  }

  if (scorecard.biggest_leverage_loss) {
    lines.push("PROBABLE CAUSE (LEVERAGE LOSS):");
    lines.push(`• "${scorecard.biggest_leverage_loss.quote}": ${scorecard.biggest_leverage_loss.note}`);
    lines.push("");
  }

  if (scorecard.next_time_instruction) {
    lines.push("RECOMMENDATION:");
    lines.push(`• ${scorecard.next_time_instruction}`);
  }

  return lines.join("\n");
}

export async function copyScorecardText(scorecard) {
  const text = getScorecardSummaryText(scorecard);
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
