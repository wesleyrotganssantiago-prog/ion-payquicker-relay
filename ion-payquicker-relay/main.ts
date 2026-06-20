const PQ_BASE = (Deno.env.get("PAYQUICKER_BASE_URL") || "https://platform.mypayquicker.com").replace(/\/$/, "");
const PQ_AUTH_BASE = (Deno.env.get("PAYQUICKER_AUTH_URL") || "https://auth.mypayquicker.com").replace(/\/$/, "");
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";
const PORT = parseInt(Deno.env.get("PORT") || "8080");
const QG_URL = Deno.env.get("QUOTAGUARDSHIELD_URL") || "";

if (!RELAY_SECRET) {
  console.error("FATAL: RELAY_SECRET env var not set.");
  Deno.exit(1);
}

console.log(`ION→PayQuicker relay starting | port:${PORT} | API:${PQ_BASE} | Auth:${PQ_AUTH_BASE} | QG:${QG_URL ? "CONFIGURED" : "DISABLED"}`);

// Build fetch options — route ALL outbound traffic through QuotaGuard static IP
// Falls back to direct fetch if proxy fails (DNS error etc.)
async function proxyFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (QG_URL) {
    try {
      const client = Deno.createHttpClient({ proxy: { url: QG_URL } });
      const res = await fetch(url, { ...options, client } as any);
      return res;
    } catch (proxyErr) {
      console.warn(`Proxy fetch failed (${proxyErr.message}), falling back to direct`);
      // Fall through to direct fetch below
    }
  }
  return fetch(url, options);
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);
  const inboundIP = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown";

  console.log(JSON.stringify({
    event: "inbound",
    method: req.method,
    path: url.pathname,
    ip: inboundIP,
    ts: new Date().toISOString(),
    hasSecret: req.headers.has("x-relay-secret"),
  }));

  // Health check — no auth needed
  if (url.pathname === "/health") {
    return Response.json({ ok: true, ts: new Date().toISOString(), proxy: !!QG_URL });
  }

  // IP check — shows the outbound IP PayQuicker sees
  if (url.pathname === "/whoami") {
    try {
      const r = await proxyFetch("https://api.ipify.org?format=json");
      const data = await r.json();
      return Response.json({ ip: data.ip, proxy_active: !!QG_URL, qg_configured: !!QG_URL });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  // ALL other routes require x-relay-secret
  if (req.headers.get("x-relay-secret") !== RELAY_SECRET) {
    console.log(JSON.stringify({ event: "forbidden", ip: inboundIP, path: url.pathname, ts: new Date().toISOString() }));
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let targetUrl: string;

  if (url.pathname.startsWith("/auth/")) {
    const targetPath = url.pathname.slice(5); // strip /auth
    targetUrl = `${PQ_AUTH_BASE}${targetPath}${url.search}`;
  } else if (url.pathname.startsWith("/pq/")) {
    const targetPath = url.pathname.slice(3); // strip /pq
    targetUrl = `${PQ_BASE}${targetPath}${url.search}`;
  } else {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const fwdHeaders = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    if (["host", "x-relay-secret", "content-length", "connection"].includes(lk)) continue;
    fwdHeaders.set(k, v);
  }

  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer();

  const started = Date.now();
  try {
    const pqRes = await proxyFetch(targetUrl, { method: req.method, headers: fwdHeaders, body });
    const respBody = await pqRes.arrayBuffer();

    console.log(JSON.stringify({
      event: "proxied",
      method: req.method,
      path: url.pathname,
      target: targetUrl,
      status: pqRes.status,
      ms: Date.now() - started,
      proxy: !!QG_URL,
      inboundIP,
    }));

    const outHeaders = new Headers();
    pqRes.headers.forEach((v, k) => {
      if (!["connection", "transfer-encoding", "content-encoding"].includes(k.toLowerCase())) {
        outHeaders.set(k, v);
      }
    });
    return new Response(respBody, { status: pqRes.status, headers: outHeaders });
  } catch (e) {
    console.error(JSON.stringify({ event: "error", error: e.message, path: url.pathname, ms: Date.now() - started }));
    return Response.json({ error: "Relay upstream error", detail: e.message }, { status: 502 });
  }
});
