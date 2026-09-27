/**
 * socket.js
 *
 * The single switch statement over every server -> client message type.
 * Spec C.6 -- converted from CommonJS `module.exports` to an ESM export, since
 * the frontend is a Vite/ESM app.
 *
 * Spec: negotiation_dojo_full_spec.md section C.6
 */

import { backendWsUrl } from "./config.js";

export function createSessionSocket(wsPath, handlers = {}) {
  const ws = new WebSocket(`${backendWsUrl()}${wsPath}`);
  let pingInterval = null;

  const call = (name, payload) => {
    const handler = handlers[name];
    if (typeof handler === "function") handler(payload);
  };

  ws.onopen = () => {
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* ignore */
        }
      }
    }, 15000);
    call("onOpen");
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.warn("Unparseable message from backend", event.data);
      return;
    }

    switch (msg.type) {
      case "session_ready":
        return call("onSessionReady", msg);
      case "transcript_partial":
        return call("onTranscriptPartial", msg);
      case "transcript_final":
        return call("onTranscriptFinal", msg);
      case "agent_audio_chunk":
        return call("onAgentAudio", msg);
      case "agent_audio_flush":
        // Barge-in: the agent was interrupted and any queued agent audio is stale.
        return call("onAgentAudioFlush", msg);
      case "tell_detected":
        return call("onTellDetected", msg);
      case "move_logged":
        return call("onMoveLogged", msg);
      case "scorecard_ready":
        return call("onScorecardReady", msg);
      case "error":
        return call("onError", msg);
      default:
        console.warn("Unhandled message type", msg.type);
    }
  };

  ws.onerror = () => {
    call("onError", {
      code: "AAI_CONNECTION_LOST",
      message: "Lost the connection to the backend.",
    });
  };

  ws.onclose = (event) => {
    if (pingInterval) clearInterval(pingInterval);
    if (event.wasClean) return;
    // Otherwise the live screen would sit there looking alive while nothing works.
    call("onError", {
      code: "AAI_CONNECTION_LOST",
      message: "The session connection dropped. You can still end the session to score what was captured.",
    });
  };

  return {
    isOpen: () => ws.readyState === WebSocket.OPEN,
    sendAudioChunk: (base64) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "audio_chunk", payload: base64 }));
      }
    },
    endSession: () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "end_session" }));
    },
    close: () => {
      if (pingInterval) clearInterval(pingInterval);
      ws.close();
    },
  };
}
