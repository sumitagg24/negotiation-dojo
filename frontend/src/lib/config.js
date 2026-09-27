/**
 * One place that decides where the backend lives.
 *
 * Vite inlines import.meta.env at BUILD time, so a URL baked in that way cannot
 * be changed without a rebuild. The runtime file (public/config.js) is read from
 * the page instead, which makes the deployed frontend reconfigurable by editing
 * one file in the repo.
 *
 * These are functions, not constants, deliberately: the global is read at call
 * time so it does not matter whether public/config.js executed before or after
 * this module. A constant captured at import time would silently fall back to
 * localhost if the script order ever changed.
 *
 * Resolution order:
 *   1. public/config.js  (runtime, no rebuild needed)
 *   2. VITE_BACKEND_URL / VITE_BACKEND_WS_URL  (build time)
 *   3. localhost:8080  (local development)
 */

function readRuntimeConfig() {
  if (typeof window === "undefined") return {};
  return window.__NEGOTIATION_DOJO__ || {};
}

/** REST base, e.g. "https://negotiation-dojo-backend.onrender.com" */
export function backendUrl() {
  return readRuntimeConfig().backendUrl || import.meta.env.VITE_BACKEND_URL || "http://localhost:8080";
}

/** WebSocket base, e.g. "wss://negotiation-dojo-backend.onrender.com" */
export function backendWsUrl() {
  return (
    readRuntimeConfig().backendWsUrl || import.meta.env.VITE_BACKEND_WS_URL || "ws://localhost:8080"
  );
}
