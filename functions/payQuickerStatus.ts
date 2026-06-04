const RELAY_URL = "https://ion-payquicker-relay.onrender.com";
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";
const PQ_CLIENT_ID = Deno.env.get("PQ_CLIENT_ID") || "";
const PQ_CLIENT_SECRET = Deno.env.get("PQ_CLIENT_SECRET") || "";

export default async function handler(req: Request): Promise<Response> {
  // 1. Check relay health + outbound IP
  let relayOk = false;
  let relayIp = "";
  try {
    const healthRes = await fetch(`${RELAY_URL}/health`, { signal: AbortSignal.timeout(5000) });
    const health = await healthRes.json();
    relayOk = health.ok === true;

    const whoami = await fetch(`${RELAY_URL}/whoami`, { signal: AbortSignal.timeout(5000) });
    const whoamiData = await whoami.json();
    relayIp = whoamiData.ip || "";
  } catch (_) {
    relayOk = false;
  }

  // 2. Get PayQuicker token via /auth/connect/token → auth.mypayquicker.com via QuotaGuard
  let pqStatus = "error";
  let pqError = "";
  if (relayOk) {
    try {
      const tokenRes = await fetch(`${RELAY_URL}/auth/connect/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-relay-secret": RELAY_SECRET,
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: PQ_CLIENT_ID,
          client_secret: PQ_CLIENT_SECRET,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (tokenRes.ok) {
        pqStatus = "connected";
      } else {
        const errText = await tokenRes.text().catch(() => "");
        pqError = errText.substring(0, 200);
        pqStatus = "error";
      }
    } catch (e) {
      pqError = e.message;
      pqStatus = "error";
    }
  }

  return Response.json({
    relay_status: relayOk ? "online" : "offline",
    relay_ip: relayIp,
    pq_api_status: pqStatus,
    pq_error: pqError || null,
    last_checked: new Date().toISOString(),
    note: "Token via /auth/connect/token → auth.mypayquicker.com | API via /pq/ → platform.mypayquicker.com",
  });
}
