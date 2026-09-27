import { useEffect, useRef } from "react";

/**
 * Spec C.5 -- props: { segments: [{ speaker, text, isFinal }] }
 * Auto-scrolls to the bottom on new segments. The only motion in the UI besides
 * the tell indicator.
 */
export default function LiveTranscript({ segments }) {
  const listRef = useRef(null);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [segments]);

  const visible = segments.filter((segment) => segment.text && segment.text.trim().length > 0);

  return (
    <div className="transcript">
      <div className="transcript__list" ref={listRef}>
        {visible.length === 0 && (
          <p className="transcript__empty">
            Alex should greet you in a moment. Speak naturally — this is a real conversation.
          </p>
        )}

        {visible.map((segment, index) => (
          <div
            key={`${segment.speaker}-${index}`}
            className={`msg msg--${segment.speaker}${segment.isFinal ? "" : " msg--partial"}`}
          >
            <span className="msg__who">{segment.speaker === "agent" ? "Alex Chen" : "You"}</span>
            <div className="msg__text">{segment.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
