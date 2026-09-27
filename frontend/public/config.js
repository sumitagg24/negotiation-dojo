/**
 * Runtime configuration for the frontend.
 *
 * This file lives in public/, so Vite copies it to the deployment verbatim and
 * does NOT bundle it. That means the backend url can be changed by editing this
 * file and pushing — no rebuild flags, no Vercel dashboard access needed.
 *
 * Resolution order used by src/lib/config.js:
 *   1. a value set below
 *   2. the build-time env var (VITE_BACKEND_URL / VITE_BACKEND_WS_URL)
 *   3. http://localhost:8080 / ws://localhost:8080
 *
 * Leave a value empty ("") to fall through to the next option.
 *
 * NOTE: when pointing at a deployed backend the protocols change. It is
 * https:// for the REST calls and wss:// for the WebSocket, and BOTH must point
 * at the same host.
 */
window.__NEGOTIATION_DOJO__ = {
  // Example: "https://negotiation-dojo-backend.onrender.com"
  backendUrl: "",

  // Example: "wss://negotiation-dojo-backend.onrender.com"
  backendWsUrl: "",
};
