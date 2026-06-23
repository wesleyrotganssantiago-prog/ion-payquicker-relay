// ION → PayQuicker Relay Service
// IdP:  https://auth.mypayquicker.build/connect/token
// API:  https://platform.mypayquicker.build/
// Proxy: QuotaGuard static IP via HTTPS_PROXY env var

const PQ_AUTH_BASE = (Deno.env.get("PAYQUICKER_AUTH_URL") || "https://auth.mypayquicker.build").replace(/\/$/, "");
const PQ_API_BASE  = (Deno.env.get("PAYQUICKER_BASE_URL") || "https://platform.mypayquicker.build").replace(/\/$/, "");
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";
const QG_URL       = Deno.env.get("HTTPS_PROXY") || Deno.env.get("QUOTAGUARDSHIELD_URL") || "";
const PORT         = parseInt(Deno.env.get("PORT") || "8080");
const API_VERSION  = "2026.02.01";

if (!RELAY_SECRET) { console.error("FATAL: RELAY_SECRET not set"); Deno.exit(1); }

console.log(`ION→PayQuicker relay | port:${PORT}`);
console.log(`Auth: ${PQ_AUTH_BASE}/connect/token`);
console.log(`API:  ${PQ_API_BASE}`);
console.log(`QuotaGuard: ${QG_URL ? "ACTIVE → " + QG_URL.split("@")[1] : "DISABLED ⚠️"}`);

async function proxyRequest(targetUrl: string, req: Request): Promise<Response> {
  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const l = k.toLowerCase();
    if (["content-type", "authorization", "accept"].includes(l)) headers.set(k, v);
  }
  headers.set("API-Version", API_VERSION);

  const body = (req.method !== "GET" && req.method !== "HEAD") ? await req.arrayBuffer() : undefined;

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers,
    body,
    signal: AbortSignal.timeout(20000),
  });

  const respHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    if (!["content-encoding", "transfer-encoding", "connection"].includes(k.toLowerCase())) {
      respHeaders.set(k, v);
    }
  }
  respHeaders.set("x-relay-via", "ion-payquicker-relay");
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);

  // Health — no auth
  if (url.pathname === "/health") {
    return Response.json({
      ok: true,
      ts: new Date().toISOString(),
      auth_base: PQ_AUTH_BASE,
      api_base: PQ_API_BASE,
      proxy: !!QG_URL,
      proxy_host: QG_URL ? QG_URL.split("@")[1] : null,
    });
  }

  // IP check — no auth
  if (url.pathname === "/whoami") {
    try {
      const r = await fetch("https://api.ipify.org/?format=json", { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      return Response.json({ ip: d.ip, proxy_active: !!QG_URL });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 502 });
    }
  }

  // Auth required for all other routes
  const secret = req.headers.get("x-relay-secret");
  if (!secret || secret !== RELAY_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Auth: POST /auth/connect/token → IdP
  if (url.pathname === "/auth/connect/token") {
    const target = `${PQ_AUTH_BASE}/connect/token`;
    console.log(`[AUTH] → ${target}`);
    try { return await proxyRequest(target, req); }
    catch (e) { return Response.json({ error: "Auth upstream error", detail: String(e) }, { status: 502 }); }
  }

  // API: /pq/* → platform.mypayquicker.build/*
  if (url.pathname.startsWith("/pq/")) {
    const pqPath = url.pathname.replace("/pq", "") + url.search;
    const target = `${PQ_API_BASE}${pqPath}`;
    console.log(`[API] ${req.method} → ${target}`);
    try { return await proxyRequest(target, req); }
    catch (e) { return Response.json({ error: "API upstream error", detail: String(e) }, { status: 502 }); }
  }

  return Response.json({ error: "Not found" }, { status: 404 });
});
