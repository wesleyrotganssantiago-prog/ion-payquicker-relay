const RELAY_URL = "https://ion-payquicker-relay.onrender.com";
const RELAY_SECRET = Deno.env.get("RELAY_SECRET") || "";
const PQ_CLIENT_ID = Deno.env.get("PQ_CLIENT_ID") || "";
const PQ_CLIENT_SECRET = Deno.env.get("PQ_CLIENT_SECRET") || "";

export default async function handler(req: Request): Promise<Response> {
  try {
    // Step 1: Get OAuth token from PayQuicker via relay
    const tokenRes = await fetch(`${RELAY_URL}/pq/connect/token`, {
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

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      return Response.json({
        success: false,
        step: "auth",
        status: tokenRes.status,
        error: tokenData,
      });
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
      signal: AbortSignal.timeout(15000),
    });

    const pingData = await pingRes.json();

    return Response.json({
      success: pingRes.ok,
      step: "api_call",
      status: pingRes.status,
      token_obtained: true,
      relay_url: RELAY_URL,
      data: pingData,
    });

  } catch (e) {
    return Response.json({
      success: false,
      error: e.message,
    }, { status: 500 });
  }
}
