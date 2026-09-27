/**
 * logNegotiationMove.js
 *
 * Exports the tool schema (spec D.2, verbatim) AND the handler that runs when a
 * tool call arrives.
 *
 * Spec: negotiation_dojo_full_spec.md section B.4
 */

const { generateId } = require("../store/sessionStore");

/** Spec D.2, verbatim. This is the canonical schema. */
const TOOL_SCHEMA = {
  name: "log_negotiation_move",
  description:
    "Call this after every user turn that contains a negotiation move — a number, a concession, a refusal, or a deflection. Always call this, even if the move is subtle.",
  input_schema: {
    type: "object",
    properties: {
      move_type: {
        type: "string",
        enum: [
          "anchor",
          "concession",
          "counter_offer",
          "deflection",
          "walkaway_threat",
          "question",
          "acceptance",
          "other",
        ],
        description: "Classify the user's most recent conversational move.",
      },
      quote: {
        type: "string",
        description: "The exact words the user said that constitute this move, verbatim.",
      },
      number_mentioned: {
        type: "number",
        description: "If the user stated a dollar figure, put it here. Omit if none.",
      },
      asked_for_reciprocity: {
        type: "boolean",
        description:
          "True if, when conceding something, the user also asked for something in return. False if they conceded with nothing asked back.",
      },
      rationale: {
        type: "string",
        description: "One sentence: why you classified it this way.",
      },
    },
    required: ["move_type", "quote", "rationale"],
  },
};

/**
 * The Voice Agent API expects a slightly different envelope than D.2: it wants
 * `type: "function"` and `parameters` instead of `input_schema`. Field names and
 * semantics of the arguments are unchanged.
 *
 * `execution_mode: "interactive"` matters here -- a "hold" tool pauses live user
 * transcripts for the duration of the call, which would stall the conversation
 * on every single turn.
 *
 * @see https://www.assemblyai.com/docs/voice-agents/voice-agent-api/events-reference
 */
function toVoiceAgentToolDefinition(schema = TOOL_SCHEMA) {
  return {
    type: "function",
    name: schema.name,
    description: schema.description,
    parameters: schema.input_schema,
    execution_mode: "interactive",
    timeout_seconds: 30,
  };
}

function handleLogNegotiationMove(sessionId, toolInput, sessionStore) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};

  // The agent can emit a dollar figure as a string; normalize so scoring math
  // never silently breaks on "95000".
  let numberMentioned = input.number_mentioned;
  if (typeof numberMentioned === "string") {
    const cleaned = Number(String(numberMentioned).replace(/[^0-9.\-]/g, ""));
    numberMentioned = Number.isFinite(cleaned) ? cleaned : undefined;
  }
  if (typeof numberMentioned === "number" && !Number.isFinite(numberMentioned)) numberMentioned = undefined;

  const move = {
    move_type: input.move_type || "other",
    quote: input.quote || "",
    rationale: input.rationale || "",
    ...(numberMentioned !== undefined ? { number_mentioned: numberMentioned } : {}),
    asked_for_reciprocity: input.asked_for_reciprocity === true,
    timestamp: Date.now(), // wall-clock time the tool call arrived
    id: generateId("move"),
  };

  sessionStore.appendMove(sessionId, move);
  return move;
}

module.exports = { TOOL_SCHEMA, toVoiceAgentToolDefinition, handleLogNegotiationMove };
