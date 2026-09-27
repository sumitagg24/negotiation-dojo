import { useEffect, useState } from "react";

/**
 * Spec C.5 -- props: { activeTell: null | { tellType, quote } }
 *
 * Shows a small pill for ~2.5s then clears itself. This is a passive side
 * indicator: it must never block the transcript or interrupt audio playback.
 */
const VISIBLE_MS = 2500;

const LABELS = {
  hesitation: "Hesitation before your number",
  retraction: "You walked the number back",
  pace_spike: "You sped up",
  mumbled_number: "You swallowed the figure",
};

export default function TellIndicator({ activeTell }) {
  const [visible, setVisible] = useState(null);

  useEffect(() => {
    if (!activeTell) return undefined;
    setVisible(activeTell);
    const timer = setTimeout(() => setVisible(null), VISIBLE_MS);
    return () => clearTimeout(timer);
    // A fresh object identity per detection re-arms the timer even if the same
    // tell fires twice in a row.
  }, [activeTell]);

  return (
    <div className="tell-strip" aria-live="polite">
      {visible && (
        <span className="tell-pill">
          <span aria-hidden="true">◦</span>
          {LABELS[visible.tellType] || "Tell detected"}
        </span>
      )}
    </div>
  );
}
