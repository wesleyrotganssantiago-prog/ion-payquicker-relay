const http = require("http");
const https = require("https");

const RELAY_SECRET = process.env.RELAY_SECRET || "";
const PQ_AUTH_BASE = "https://auth.mypayquicker.com";
const PQ_API_BASE = "https://platform.mypayquicker.com";
const PORT = parseInt(process.env.PORT || "8080");

if (!RELAY_SECRET) {
  console.error("FATAL: RELAY_SECRET env var not set.");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // Health check — no auth needed
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
  }

  // IP check — no auth needed
  if (url.pathname === "/whoami") {
    try {
      const ip = await fetchJson("https://api.ipify.org?format=json");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(ip));
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
  if (body.length > 0) fwdHeaders["content-length"] = body.length;

  const started = Date.now();
  try {
    const pqRes = await proxyFetch(req.method, targetUrl, fwdHeaders, body);
    console.log(JSON.stringify({ method: req.method, path: url.pathname, target: targetUrl, status: pqRes.status, ms: Date.now() - started }));
    res.writeHead(pqRes.status, pqRes.headers);
    res.end(pqRes.body);
  } catch (e) {
    console.error(JSON.stringify({ error: e.message, path: url.pathname, ms: Date.now() - started }));
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Relay upstream error", detail: e.message }));
  }
});

function proxyFetch(method, targetUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const outHeaders = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (!["connection", "transfer-encoding", "content-encoding"].includes(k.toLowerCase())) {
            outHeaders[k] = v;
          }
        }
        resolve({ status: res.statusCode, headers: outHeaders, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    if (body && body.length > 0) req.write(body);
    req.end();
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    }).on("error", reject);
  });
}

server.listen(PORT, () => console.log(`ION→PayQuicker relay on port ${PORT}`));
