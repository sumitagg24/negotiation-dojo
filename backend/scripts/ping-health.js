#!/usr/bin/env node
/**
 * ping-health.js
 *
 * Standalone CLI script to ping the Negotiation Dojo backend /api/health endpoint.
 * Useful for external cron jobs (cron-job.org, GitHub Actions, custom runners) or manual sanity checks.
 *
 * Usage:
 *   node scripts/ping-health.js [URL]
 *   npm run ping
 *
 * Examples:
 *   node scripts/ping-health.js
 *   node scripts/ping-health.js https://negotiation-dojo-backend.onrender.com/api/health
 */

require("dotenv").config();

const targetUrl =
  process.argv[2] ||
  process.env.KEEP_ALIVE_URL ||
  (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/api/health` : "") ||
  (process.env.BACKEND_URL ? `${process.env.BACKEND_URL}/api/health` : "") ||
  "http://localhost:8080/api/health";

console.log(`[ping] Pinging target: ${targetUrl}`);
const start = Date.now();

fetch(targetUrl, {
  method: "GET",
  headers: {
    "User-Agent": "NegotiationDojo-PingCLI/1.0",
    "X-Keep-Alive": "true",
  },
})
  .then(async (res) => {
    const elapsed = Date.now() - start;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore
    }

    if (res.ok) {
      console.log(`[ping] SUCCESS (HTTP ${res.status}) in ${elapsed}ms`);
      if (json) {
        console.log(`[ping] Response:`, JSON.stringify(json, null, 2));
      } else {
        console.log(`[ping] Response:`, text);
      }
      process.exit(0);
    } else {
      console.error(`[ping] FAILED (HTTP ${res.status}) in ${elapsed}ms`);
      console.error(`[ping] Response:`, text);
      process.exit(1);
    }
  })
  .catch((err) => {
    const elapsed = Date.now() - start;
    console.error(`[ping] ERROR in ${elapsed}ms:`, err.message);
    process.exit(1);
  });
