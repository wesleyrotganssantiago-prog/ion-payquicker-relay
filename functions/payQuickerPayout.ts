import { createClientFromRequest } from "npm:@base44/sdk";

const RELAY_URL = "https://ion-payquicker-relay-production-13c8.up.railway.app";
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";
const PQ_CLIENT_ID = Deno.env.get("PQ_CLIENT_ID") || "";
const PQ_CLIENT_SECRET = Deno.env.get("PQ_CLIENT_SECRET") || "";

async function getPQToken(): Promise<string> {
  const res = await fetch(`${RELAY_URL}/pq/v2/oauth2/token`, {
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
  if (!res.ok) throw new Error(`PQ auth failed: ${res.status}`);
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
  return { status: res.status, data: await res.json() };
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

    // Action: bulk payout (array of {user_token, amount})
    if (action === "bulk_payout") {
      const results = [];
      for (const payout of payouts) {
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
      return Response.json({ success: true, results, total: results.length });
    }

    // Action: get user info from PQ
    if (action === "get_user") {
      const result = await pqRequest(token, "GET", `/v2/users/${user_token}`);
      return Response.json(result);
    }

    // Action: list PQ users
    if (action === "list_users") {
      const result = await pqRequest(token, "GET", "/v2/users?pageSize=20");
      return Response.json(result);
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });

  } catch (e) {
    return Response.json({
      success: false,
      error: e.message,
    }, { status: 500 });
  }
}
