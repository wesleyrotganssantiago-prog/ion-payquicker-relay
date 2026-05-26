const PQ_BASE = (Deno.env.get("PAYQUICKER_BASE_URL") || "https://platform.mypayquicker.com").replace(/\/$/, "");
const PQ_AUTH_URL = (Deno.env.get("PQ_AUTH_URL") || "https://auth.mypayquicker.com").replace(/\/$/, "");
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";
const PORT = parseInt(Deno.env.get("PORT") || "8080");

if (!RELAY_SECRET) {
  console.error("FATAL: RELAY_SECRET env var not set.");
  Deno.exit(1);
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    return Response.json({ ok: true, ts: new Date().toISOString() });
  }

  if (url.pathname === "/whoami") {
    try {
      const r = await fetch("https://api.ipify.org?format=json");
      return new Response(await r.text(), { headers: { "content-type": "application/json" } });
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

  const targetPath = url.pathname.slice(3); // remove /pq prefix

  // Token calls go to auth.mypayquicker.com, everything else to platform.mypayquicker.com
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
  } catch (e) {
    console.error(JSON.stringify({ error: e.message, path: url.pathname, ms: Date.now() - started }));
    return Response.json({ error: "Relay upstream error", detail: e.message }, { status: 502 });
  }
});

console.log(`ION→PayQuicker relay listening on :${PORT}`);
console.log(`API base: ${PQ_BASE}`);
console.log(`Auth base: ${PQ_AUTH_URL}`);
