// ION → PayQuicker Relay Service
// Routes requests via this server to give a static outbound IP
// Auth:  POST /auth/connect/token  → api.sandbox.payquicker.io/api/v2/auth/connect/token
// API:   /pq/*                     → api.sandbox.payquicker.io/api/v2/*

const PQ_SANDBOX_BASE = (Deno.env.get("PAYQUICKER_BASE_URL") || "https://api.sandbox.payquicker.io/api/v2").replace(/\/$/, "");
const RELAY_SECRET    = Deno.env.get("RELAY_SECRET") || "";
const PORT            = parseInt(Deno.env.get("PORT") || "8080");
const API_VERSION     = "2026.02.01";

if (!RELAY_SECRET) {
  console.error("FATAL: RELAY_SECRET env var not set.");
  Deno.exit(1);
}

console.log(`ION→PayQuicker relay starting | port:${PORT} | PQ:${PQ_SANDBOX_BASE}`);

async function proxyRequest(targetUrl: string, req: Request): Promise<Response> {
  const headers = new Headers();

  // Forward relevant headers, add required API-Version
  for (const [k, v] of req.headers.entries()) {
    const lower = k.toLowerCase();
    if (["content-type", "authorization", "accept"].includes(lower)) {
      headers.set(k, v);
    }
  }
  headers.set("API-Version", API_VERSION);

  const body = req.method !== "GET" && req.method !== "HEAD"
    ? await req.arrayBuffer()
    : undefined;

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

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);

  // Health check (no auth required)
  if (url.pathname === "/health") {
    return Response.json({ ok: true, ts: new Date().toISOString(), pq_base: PQ_SANDBOX_BASE });
  }

  // IP check (no auth required)
  if (url.pathname === "/whoami") {
    try {
      const r = await fetch("https://api.ipify.org/?format=json", { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      return Response.json({ ip: d.ip });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 502 });
    }
  }

  // All other routes require relay secret
  const secret = req.headers.get("x-relay-secret");
  if (!secret || secret !== RELAY_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Auth route: POST /auth/connect/token → PQ_SANDBOX_BASE/auth/connect/token
  if (url.pathname === "/auth/connect/token") {
    const target = `${PQ_SANDBOX_BASE}/auth/connect/token`;
    console.log(`[AUTH] → ${target}`);
    try {
      return await proxyRequest(target, req);
    } catch (e) {
      return Response.json({ error: "Relay upstream error", detail: String(e) }, { status: 502 });
    }
  }

  // API route: /pq/* → PQ_SANDBOX_BASE/*
  if (url.pathname.startsWith("/pq/")) {
    const pqPath = url.pathname.replace("/pq", "") + url.search;
    const target = `${PQ_SANDBOX_BASE}${pqPath}`;
    console.log(`[API] ${req.method} → ${target}`);
    try {
      return await proxyRequest(target, req);
    } catch (e) {
      return Response.json({ error: "Relay upstream error", detail: String(e) }, { status: 502 });
    }
  }

  return Response.json({ error: "Not found" }, { status: 404 });
});
