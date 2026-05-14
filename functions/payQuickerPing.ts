import { createClientFromRequest } from "npm:@base44/sdk";

const RELAY_URL = "https://ion-payquicker-relay-production.up.railway.app";
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";
const PQ_CLIENT_ID = Deno.env.get("PQ_CLIENT_ID") || "";
const PQ_CLIENT_SECRET = Deno.env.get("PQ_CLIENT_SECRET") || "";

export default async function handler(req: Request): Promise<Response> {
  try {
    // Step 1: Get OAuth token from PayQuicker via relay
    const tokenRes = await fetch(`${RELAY_URL}/pq/v2/oauth2/token`, {
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
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      return Response.json({
        success: false,
        step: "auth",
        status: tokenRes.status,
        error: tokenData,
      }, { status: 200 });
    }

    const accessToken = tokenData.access_token;

    // Step 2: Test a simple API call - list users
    const pingRes = await fetch(`${RELAY_URL}/pq/v2/users?pageSize=1`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "x-relay-secret": RELAY_SECRET,
        "Accept": "application/json",
      },
    });

    const pingData = await pingRes.json();

    return Response.json({
      success: pingRes.ok,
      step: "api_call",
      status: pingRes.status,
      token_obtained: true,
      data: pingData,
    });

  } catch (e) {
    return Response.json({
      success: false,
      error: e.message,
    }, { status: 500 });
  }
}
