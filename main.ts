const PQ_BASE = (Deno.env.get("PAYQUICKER_BASE_URL") || "https://platform.mypayquicker.com").replace(/\/$/, "");
const PQ_AUTH_URL = (Deno.env.get("PQ_AUTH_URL") || "https://auth.mypayquicker.com").replace(/\/$/, "");
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";
const PORT = parseInt(Deno.env.get("PORT") || "8080");
const QG_URL = Deno.env.get("QUOTAGUARDSHIELD_URL") || "";

if (!RELAY_SECRET) {
  console.error("FATAL: RELAY_SECRET env var not set.");
  Deno.exit(1);
}

if (QG_URL) {
  console.log("QuotaGuard proxy enabled via HTTPS_PROXY");
} else {
  console.warn("WARNING: QUOTAGUARDSHIELD_URL not set — outbound IP will not be static");
}

// Set proxy env vars so Deno's fetch uses QuotaGuard
if (QG_URL) {
  // Deno respects HTTPS_PROXY and HTTP_PROXY environment variables natively
  Deno.env.set("HTTPS_PROXY", QG_URL);
  Deno.env.set("HTTP_PROXY", QG_URL);
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    return Response.json({ ok: true, ts: new Date().toISOString(), proxy: !!QG_URL });
  }

  if (url.pathname === "/whoami") {
    try {
      const r = await fetch("https://api.ipify.org?format=json");
      const data = await r.json();
      return Response.json({ ...data, proxy_active: !!QG_URL });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  if (req.headers.get("x-relay-secret") !== RELAY_SECRET) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!url.pathname.startsWith("/pq/")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const targetPath = url.pathname.slice(3);

  const isAuthCall = targetPath === "/connect/token" || targetPath.startsWith("/connect/");
  const baseUrl = isAuthCall ? PQ_AUTH_URL : PQ_BASE;
  const targetUrl = `${baseUrl}${targetPath}${url.search}`;

  const fwdHeaders = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    if (["host", "x-relay-secret", "content-length", "connection"].includes(lk)) continue;
    fwdHeaders.set(k, v);
  }

  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer();

  const started = Date.now();
  try {
    const pqRes = await fetch(targetUrl, { method: req.method, headers: fwdHeaders, body });
    const respBody = await pqRes.arrayBuffer();
    console.log(JSON.stringify({ method: req.method, path: url.pathname, target: targetUrl, status: pqRes.status, ms: Date.now() - started }));
    const outHeaders = new Headers();
    pqRes.headers.forEach((v, k) => {
      if (!["connection", "transfer-encoding", "content-encoding"].includes(k.toLowerCase())) {
        outHeaders.set(k, v);
      }
    });
    return new Response(respBody, { status: pqRes.status, headers: outHeaders });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ error: msg, path: url.pathname, ms: Date.now() - started }));
    return Response.json({ error: "Relay upstream error", detail: msg }, { status: 502 });
  }
});

console.log(`ION→PayQuicker relay listening on :${PORT}`);
console.log(`API base: ${PQ_BASE}`);
console.log(`Auth base: ${PQ_AUTH_URL}`);
