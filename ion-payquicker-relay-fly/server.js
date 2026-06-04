const http = require("http");
const https = require("https");
const { ProxyAgent, setGlobalDispatcher, fetch: undiciFetch } = require("undici");

const RELAY_SECRET = process.env.RELAY_SECRET || "";
const PQ_AUTH_BASE = "https://auth.mypayquicker.com";
const PQ_API_BASE = "https://platform.mypayquicker.com";
const PORT = parseInt(process.env.PORT || "8080");
const QG_URL = process.env.QUOTAGUARDSHIELD_URL;

if (!RELAY_SECRET) {
  console.error("FATAL: RELAY_SECRET env var not set.");
  process.exit(1);
}

// Route ALL outbound traffic through QuotaGuard if configured
if (QG_URL) {
  setGlobalDispatcher(new ProxyAgent(QG_URL));
  console.log("QuotaGuard proxy enabled");
} else {
  console.warn("WARNING: QUOTAGUARDSHIELD_URL not set — outbound IP will not be static");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // Health check — no auth needed
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: new Date().toISOString(), proxy: !!QG_URL }));
  }

  // IP check — no auth needed (shows the outbound IP PayQuicker sees)
  if (url.pathname === "/whoami") {
    try {
      const r = await undiciFetch("https://api.ipify.org?format=json");
      const data = await r.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ...data, proxy_active: !!QG_URL }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // Auth check for all /pq/ routes
  if (req.headers["x-relay-secret"] !== RELAY_SECRET) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Forbidden" }));
  }

  if (!url.pathname.startsWith("/pq/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Not found" }));
  }

  const targetPath = url.pathname.slice(3) + (url.search || "");

  // Token calls go to auth.mypayquicker.com, everything else to platform
  const isTokenCall = targetPath.includes("/connect/token") || targetPath.includes("/oauth2/token");
  const targetBase = isTokenCall ? PQ_AUTH_BASE : PQ_API_BASE;
  const targetUrl = `${targetBase}${targetPath}`;

  // Collect request body
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);

  // Forward headers (strip hop-by-hop)
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (["host", "x-relay-secret", "content-length", "connection", "transfer-encoding"].includes(lk)) continue;
    fwdHeaders[k] = v;
  }

  const started = Date.now();
  try {
    const pqRes = await undiciFetch(targetUrl, {
      method: req.method,
      headers: fwdHeaders,
      body: body.length > 0 ? body : undefined,
    });

    const respBody = Buffer.from(await pqRes.arrayBuffer());
    console.log(JSON.stringify({ method: req.method, path: url.pathname, target: targetUrl, status: pqRes.status, ms: Date.now() - started }));

    const outHeaders = {};
    pqRes.headers.forEach((v, k) => {
      if (!["connection", "transfer-encoding", "content-encoding"].includes(k.toLowerCase())) {
        outHeaders[k] = v;
      }
    });

    res.writeHead(pqRes.status, outHeaders);
    res.end(respBody);
  } catch (e) {
    console.error(JSON.stringify({ error: e.message, path: url.pathname, ms: Date.now() - started }));
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Relay upstream error", detail: e.message }));
  }
});

server.listen(PORT, () => console.log(`ION→PayQuicker relay on port ${PORT}`));
