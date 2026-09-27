const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const {
  startKeepAlive,
  stopKeepAlive,
  getKeepAliveStatus,
  triggerKeepAlivePing,
  resolveTargetUrl,
  isKeepAliveEnabled,
} = require("../src/cron/keepAlive");

test("resolveTargetUrl resolves RENDER_EXTERNAL_URL, KEEP_ALIVE_URL and BACKEND_URL", () => {
  const origKeepAlive = process.env.KEEP_ALIVE_URL;
  const origRender = process.env.RENDER_EXTERNAL_URL;
  const origBackend = process.env.BACKEND_URL;

  try {
    delete process.env.KEEP_ALIVE_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    delete process.env.BACKEND_URL;
    assert.equal(resolveTargetUrl(), "");

    process.env.RENDER_EXTERNAL_URL = "https://negotiation-dojo-backend.onrender.com/";
    assert.equal(
      resolveTargetUrl(),
      "https://negotiation-dojo-backend.onrender.com/api/health",
    );

    process.env.BACKEND_URL = "https://custom-backend.com";
    delete process.env.RENDER_EXTERNAL_URL;
    assert.equal(resolveTargetUrl(), "https://custom-backend.com/api/health");

    process.env.KEEP_ALIVE_URL = "https://ping.example.com/custom-health";
    assert.equal(resolveTargetUrl(), "https://ping.example.com/custom-health");
  } finally {
    if (origKeepAlive !== undefined) process.env.KEEP_ALIVE_URL = origKeepAlive;
    else delete process.env.KEEP_ALIVE_URL;
    if (origRender !== undefined) process.env.RENDER_EXTERNAL_URL = origRender;
    else delete process.env.RENDER_EXTERNAL_URL;
    if (origBackend !== undefined) process.env.BACKEND_URL = origBackend;
    else delete process.env.BACKEND_URL;
  }
});

test("isKeepAliveEnabled respects explicit env flags and defaults", () => {
  const orig = process.env.KEEP_ALIVE_ENABLED;
  const origNodeEnv = process.env.NODE_ENV;

  try {
    process.env.KEEP_ALIVE_ENABLED = "false";
    assert.equal(isKeepAliveEnabled("https://target.com"), false);

    process.env.KEEP_ALIVE_ENABLED = "true";
    assert.equal(isKeepAliveEnabled(""), true);

    delete process.env.KEEP_ALIVE_ENABLED;
    process.env.NODE_ENV = "production";
    assert.equal(isKeepAliveEnabled(""), true);

    process.env.NODE_ENV = "development";
    assert.equal(isKeepAliveEnabled("https://target.com"), true);
    assert.equal(isKeepAliveEnabled(""), false);
  } finally {
    if (orig !== undefined) process.env.KEEP_ALIVE_ENABLED = orig;
    else delete process.env.KEEP_ALIVE_ENABLED;
    if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
    else delete process.env.NODE_ENV;
  }
});

test("executePing performs real HTTP GET and records telemetry", async () => {
  let pingCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/api/health") {
      pingCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/health`;

  const origKeepAlive = process.env.KEEP_ALIVE_URL;
  process.env.KEEP_ALIVE_URL = url;

  try {
    const res = await triggerKeepAlivePing();
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(pingCount, 1);

    const status = getKeepAliveStatus();
    assert.equal(status.totalPings >= 1, true);
    assert.equal(status.successfulPings >= 1, true);
    assert.equal(status.lastStatus, 200);
    assert.ok(typeof status.lastLatencyMs === "number");
    assert.ok(status.lastPingAt !== null);
  } finally {
    stopKeepAlive();
    if (origKeepAlive !== undefined) process.env.KEEP_ALIVE_URL = origKeepAlive;
    else delete process.env.KEEP_ALIVE_URL;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("executePing safely handles failure without throwing", async () => {
  const origKeepAlive = process.env.KEEP_ALIVE_URL;
  // Non-routable or dead port
  process.env.KEEP_ALIVE_URL = "http://127.0.0.1:59999/api/health";

  try {
    const res = await triggerKeepAlivePing();
    assert.equal(res.ok, false);
    const status = getKeepAliveStatus();
    assert.equal(status.failedPings >= 1, true);
    assert.ok(status.lastError !== null);
  } finally {
    stopKeepAlive();
    if (origKeepAlive !== undefined) process.env.KEEP_ALIVE_URL = origKeepAlive;
    else delete process.env.KEEP_ALIVE_URL;
  }
});
