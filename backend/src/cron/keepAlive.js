/**
 * keepAlive.js
 *
 * Keep-alive self-pinging background service to prevent Render free-tier web services
 * from spinning down after 15 minutes of inactivity.
 *
 * Render spins down free web services after ~15 minutes without incoming HTTP traffic.
 * By periodically sending an HTTP GET request to its own public URL (/api/health),
 * Render's reverse proxy receives external web traffic and resets the 15-minute
 * inactivity timer, keeping the service hot and eliminating 30-60s cold starts.
 */

let timerId = null;
let retryTimerId = null;

const stats = {
  enabled: false,
  targetUrl: "",
  intervalMinutes: 10,
  lastPingAt: null,
  lastStatus: null,
  lastLatencyMs: null,
  totalPings: 0,
  successfulPings: 0,
  failedPings: 0,
  consecutiveFailures: 0,
  lastError: null,
  nextPingAt: null,
};

/**
 * Resolves the URL to ping.
 * Render automatically injects `RENDER_EXTERNAL_URL` (e.g. "https://negotiation-dojo-backend.onrender.com").
 */
function resolveTargetUrl() {
  if (process.env.KEEP_ALIVE_URL) {
    return process.env.KEEP_ALIVE_URL.trim();
  }

  const base = (
    process.env.RENDER_EXTERNAL_URL ||
    process.env.BACKEND_URL ||
    process.env.SELF_URL ||
    ""
  ).trim().replace(/\/+$/, "");

  if (base) {
    return `${base}/api/health`;
  }

  return "";
}

/**
 * Determines whether keep-alive should run.
 * Defaults to true if target URL is present or in production environment,
 * unless explicitly disabled with KEEP_ALIVE_ENABLED=false.
 */
function isKeepAliveEnabled(targetUrl) {
  const explicit = process.env.KEEP_ALIVE_ENABLED;
  if (explicit !== undefined) {
    return String(explicit).toLowerCase() === "true" || explicit === "1";
  }

  // If a public target URL is known, enable by default.
  if (targetUrl) return true;

  // In production, even if URL is not yet explicitly set, keep alive is wanted.
  return process.env.NODE_ENV === "production";
}

/**
 * Executes a single ping attempt.
 */
async function executePing(options = {}) {
  const { isRetry = false } = options;
  const targetUrl = resolveTargetUrl();
  stats.targetUrl = targetUrl;

  if (!targetUrl) {
    stats.lastError = "No target URL configured (set RENDER_EXTERNAL_URL or KEEP_ALIVE_URL)";
    console.log(`[keepAlive] ping skipped: ${stats.lastError}`);
    return { ok: false, error: stats.lastError };
  }

  const timeoutMs = Number(process.env.KEEP_ALIVE_TIMEOUT_MS) || 30000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const res = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": "NegotiationDojo-KeepAlive/1.0",
        "X-Keep-Alive": "true",
      },
      signal: controller.signal,
    });

    const latencyMs = Date.now() - start;
    stats.lastPingAt = new Date().toISOString();
    stats.lastStatus = res.status;
    stats.lastLatencyMs = latencyMs;
    stats.totalPings += 1;

    if (res.ok) {
      stats.successfulPings += 1;
      stats.consecutiveFailures = 0;
      stats.lastError = null;
      console.log(
        `[keepAlive] ${isRetry ? "retry " : ""}ping successful -> ${targetUrl} (status: ${res.status}, latency: ${latencyMs}ms)`,
      );
      return { ok: true, status: res.status, latencyMs };
    } else {
      stats.failedPings += 1;
      stats.consecutiveFailures += 1;
      stats.lastError = `HTTP ${res.status}`;
      console.warn(
        `[keepAlive] ping responded with non-2xx -> ${targetUrl} (status: ${res.status}, latency: ${latencyMs}ms)`,
      );
      scheduleRetry();
      return { ok: false, status: res.status, latencyMs };
    }
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isAbort = err.name === "AbortError";
    const errorMessage = isAbort ? `timeout after ${timeoutMs}ms` : err.message;

    stats.lastPingAt = new Date().toISOString();
    stats.lastStatus = 0;
    stats.lastLatencyMs = latencyMs;
    stats.totalPings += 1;
    stats.failedPings += 1;
    stats.consecutiveFailures += 1;
    stats.lastError = errorMessage;

    console.warn(`[keepAlive] ping failed -> ${targetUrl} (${errorMessage})`);
    scheduleRetry();
    return { ok: false, error: errorMessage };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * If a ping fails, schedule a single quick retry after 30 seconds so a temporary
 * glitch doesn't let the service sit idle for the remainder of the 10-15 minute window.
 */
function scheduleRetry() {
  if (retryTimerId) clearTimeout(retryTimerId);
  if (stats.consecutiveFailures >= 3) return; // avoid tight loops if network is completely down

  retryTimerId = setTimeout(() => {
    retryTimerId = null;
    executePing({ isRetry: true }).catch(() => {});
  }, 30000);
}

/**
 * Schedules the next recurring keep-alive ping.
 */
function scheduleNext(intervalMinutes) {
  const intervalMs = Math.max(1, Math.min(14, intervalMinutes)) * 60 * 1000;
  stats.nextPingAt = new Date(Date.now() + intervalMs).toISOString();

  timerId = setTimeout(async () => {
    await executePing().catch(() => {});
    scheduleNext(intervalMinutes);
  }, intervalMs);

  if (typeof timerId.unref === "function") {
    // Allows Node to exit gracefully on SIGTERM/SIGINT without timer hanging the process
    timerId.unref();
  }
}

/**
 * Starts the keep-alive service.
 */
function startKeepAlive() {
  stopKeepAlive();

  const targetUrl = resolveTargetUrl();
  const enabled = isKeepAliveEnabled(targetUrl);
  stats.enabled = enabled;
  stats.targetUrl = targetUrl;

  const rawMinutes = Number(process.env.KEEP_ALIVE_INTERVAL_MINUTES);
  // Default to 10 minutes; clamp between 1 and 14 minutes (Render sleeps at 15 minutes)
  const intervalMinutes = Number.isFinite(rawMinutes) && rawMinutes > 0
    ? Math.max(1, Math.min(14, rawMinutes))
    : 10;
  stats.intervalMinutes = intervalMinutes;

  if (!enabled) {
    console.log("[keepAlive] background keep-alive is standby/disabled (set KEEP_ALIVE_ENABLED=true or RENDER_EXTERNAL_URL to activate)");
    return;
  }

  console.log(
    `[keepAlive] started keep-alive cron: targeting "${targetUrl || "(awaiting configuration)"}" every ${intervalMinutes}m`,
  );

  // Initial ping after 20 seconds to confirm the service is warm
  const initialDelayMs = Number(process.env.KEEP_ALIVE_INITIAL_DELAY_MS) || 20000;
  const initialTimer = setTimeout(() => {
    executePing().catch(() => {});
  }, initialDelayMs);
  if (typeof initialTimer.unref === "function") initialTimer.unref();

  scheduleNext(intervalMinutes);
}

/**
 * Stops the keep-alive service.
 */
function stopKeepAlive() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
  }
  if (retryTimerId) {
    clearTimeout(retryTimerId);
    retryTimerId = null;
  }
  stats.enabled = false;
  stats.nextPingAt = null;
}

/**
 * Returns current keep-alive diagnostic state.
 */
function getKeepAliveStatus() {
  return {
    ...stats,
    targetUrl: stats.targetUrl || resolveTargetUrl(),
  };
}

module.exports = {
  startKeepAlive,
  stopKeepAlive,
  getKeepAliveStatus,
  triggerKeepAlivePing: executePing,
  resolveTargetUrl,
  isKeepAliveEnabled,
};
