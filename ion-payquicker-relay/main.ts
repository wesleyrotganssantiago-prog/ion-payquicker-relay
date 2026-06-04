const PQ_BASE = (Deno.env.get("PAYQUICKER_BASE_URL") || "https://ionsavings.mypayquicker.com").replace(/\/$/, "");
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";
const PORT = parseInt(Deno.env.get("PORT") || "8080");
const QG_URL = Deno.env.get("QUOTAGUARDSHIELD_URL") || "";

if (!RELAY_SECRET) {
  console.error("FATAL: RELAY_SECRET env var not set.");
  Deno.exit(1);
}

// Build fetch options — route through QuotaGuard SOCKS5/HTTP proxy if available
async function proxyFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (QG_URL) {
    // Use Deno's built-in proxy support via client
    const client = Deno.createHttpClient({ proxy: { url: QG_URL } });
    return fetch(url, { ...options, client } as any);
  }
  return fetch(url, options);
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    const proxyActive = !!QG_URL;
    return Response.json({ ok: true, ts: new Date().toISOString(), proxy: proxyActive });
  }

  if (url.pathname === "/whoami") {
    try {
      const r = await proxyFetch("https://api.ipify.org?format=json");
      const data = await r.json();
      return Response.json({ ip: data.ip, proxy_active: !!QG_URL });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  }

  if (req.headers.get("x-relay-secret") !== RELAY_SECRET) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!url.pathname.startsWith("/pq/")) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const targetPath = url.pathname.slice(3);
  const targetUrl = `${PQ_BASE}${targetPath}${url.search}`;

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
    console.log(JSON.stringify({ method: req.method, path: url.pathname, target: targetUrl, status: pqRes.status, ms: Date.now() - started, proxy: !!QG_URL }));
    const outHeaders = new Headers();
    pqRes.headers.forEach((v, k) => {
      if (!["connection", "transfer-encoding", "content-encoding"].includes(k.toLowerCase())) {
        outHeaders.set(k, v);
      }
    });
    return new Response(respBody, { status: pqRes.status, headers: outHeaders });
  } catch (e) {
    console.error(JSON.stringify({ error: e.message, path: url.pathname, ms: Date.now() - started }));
    return Response.json({ error: "Relay upstream error", detail: e.message }, { status: 502 });
  }
});

console.log(`ION→PayQuicker relay listening on port ${PORT} | QuotaGuard: ${QG_URL ? "ACTIVE" : "DISABLED"}`);
