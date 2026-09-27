/**
 * Spec C.5 -- props: { moves: [...] }
 * Vertical list, newest at top, move_type as a colour-coded tag, quote truncated
 * to one line.
 */
const TAG_LABELS = {
  anchor: "Anchor",
  concession: "Concession",
  counter_offer: "Counter",
  deflection: "Deflection",
  walkaway_threat: "Walk-away",
  question: "Question",
  acceptance: "Acceptance",
  other: "Move",
};

function formatMoney(value) {
  return `$${Number(value).toLocaleString("en-US")}`;
}

export default function MoveTimeline({ moves }) {
  return (
    <div className="timeline">
      {moves.length === 0 && (
        <p className="timeline__empty">The moves Alex logs will appear here as you negotiate.</p>
      )}

      {moves.map((move, index) => (
        <div className="timeline__item" key={move.id || `${move.move_type}-${index}`}>
          <div className="timeline__meta">
            <span className={`tag tag--${move.move_type || "other"}`}>
              {TAG_LABELS[move.move_type] || "Move"}
            </span>
            {typeof move.number_mentioned === "number" && (
              <span className="timeline__number">{formatMoney(move.number_mentioned)}</span>
            )}
          </div>
          <div className="timeline__quote" title={move.quote}>
            "{move.quote}"
          </div>
        </div>
      ))}
    </div>
  );
}
