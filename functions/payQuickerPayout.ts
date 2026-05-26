import { createClientFromRequest } from "npm:@base44/sdk";

const RELAY_URL = "https://ion-payquicker-relay.onrender.com";
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";
const PQ_CLIENT_ID = Deno.env.get("PQ_CLIENT_ID") || "";
const PQ_CLIENT_SECRET = Deno.env.get("PQ_CLIENT_SECRET") || "";

// Greg Fruin (PayQuicker) confirmed:
// - Token URL: https://auth.mypayquicker.com/connect/token  → relay path: /pq/connect/token
// - API URL:   https://platform.mypayquicker.com            → relay path: /pq/...
// DataDome only protects client-facing URLs, NOT the API endpoints above.

async function getPQToken(): Promise<string> {
  const res = await fetch(`${RELAY_URL}/pq/connect/token`, {
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
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`PQ auth failed: ${res.status} — ${errText.substring(0, 200)}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function pqRequest(token: string, method: string, path: string, body?: object) {
  const res = await fetch(`${RELAY_URL}/pq${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "x-relay-secret": RELAY_SECRET,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

export default async function handler(req: Request): Promise<Response> {
  const client = createClientFromRequest(req);
  const body = await req.json();
  const { action, payouts, user_token, amount, currency = "USD", batch_id } = body;

  try {
    const token = await getPQToken();

    // Action: single payout
    if (action === "single_payout") {
      const result = await pqRequest(token, "POST", "/v2/transfers", {
        destinationToken: user_token,
        amount: { value: amount, currency },
        memo: `ION Commission - ${new Date().toISOString().split("T")[0]}`,
      });
      return Response.json({ success: result.status < 300, ...result });
    }

    // Action: bulk payout — concurrent (10 workers as Greg recommended)
    if (action === "bulk_payout") {
      const queue = [...payouts];
      const results: any[] = [];
      const CONCURRENCY = 10;

      async function worker() {
        while (queue.length > 0) {
          const payout = queue.shift();
          if (!payout) break;
          try {
            const result = await pqRequest(token, "POST", "/v2/transfers", {
              destinationToken: payout.user_token,
              amount: { value: payout.amount, currency: payout.currency || "USD" },
              memo: `ION Commission - Batch ${batch_id || new Date().toISOString().split("T")[0]}`,
            });
            results.push({
              member_id: payout.member_id,
              member_name: payout.member_name,
              success: result.status < 300,
              transfer_token: result.data?.token,
              error: result.status >= 300 ? result.data : null,
            });
          } catch (e) {
            results.push({
              member_id: payout.member_id,
              member_name: payout.member_name,
              success: false,
              error: e.message,
            });
          }
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return Response.json({ success: true, results, total: results.length });
    }

    // Action: get user info
    if (action === "get_user") {
      const result = await pqRequest(token, "GET", `/v2/users/${user_token}`);
      return Response.json(result);
    }

    // Action: list users
    if (action === "list_users") {
      const result = await pqRequest(token, "GET", "/v2/users?pageSize=20");
      return Response.json(result);
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });

  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}
