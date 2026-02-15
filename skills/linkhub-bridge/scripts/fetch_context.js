#!/usr/bin/env node

const userId = process.argv[2];
const message = process.argv[3];
const userJwtFromArg = process.argv[4];

if (!userId || !message) {
  console.error(JSON.stringify({ error: "Missing args: userId and message are required" }));
  process.exit(1);
}

const bridgeUrl = process.env.AGENT_BRIDGE_URL;
if (!bridgeUrl) {
  console.error(JSON.stringify({ error: "AGENT_BRIDGE_URL not set" }));
  process.exit(1);
}

const serviceId = process.env.OPENCLAW_SERVICE_ID;
const serviceKey = process.env.OPENCLAW_SERVICE_KEY;
if (!serviceId || !serviceKey) {
  console.error(
    JSON.stringify({
      error: "OPENCLAW_SERVICE_ID and OPENCLAW_SERVICE_KEY must be set",
    }),
  );
  process.exit(1);
}

const appKey = process.env.OPENCLAW_APP_KEY || "linkhub-w4";
const userJwt = userJwtFromArg || process.env.OPENCLAW_USER_JWT;
if (!userJwt) {
  console.error(
    JSON.stringify({
      error:
        "Missing user JWT. Pass it as 3rd arg or set OPENCLAW_USER_JWT for user-mode bridge functions",
    }),
  );
  process.exit(1);
}

const endpoint = `${bridgeUrl.replace(/\/$/, "")}/agent/execute`;

async function executeFunction(functionKey, args) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Service-Id": serviceId,
      "X-Agent-Service-Key": serviceKey,
      "X-Agent-App": appKey,
      Authorization: `Bearer ${userJwt}`,
    },
    body: JSON.stringify({
      functionKey,
      args,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const payload = await response.json();
  if (!payload?.success) {
    throw new Error(`Bridge execution failed for ${functionKey}`);
  }
  return payload.result;
}

async function main() {
  const result = {
    input: {
      userId,
      message,
      tenantId: process.env.TENANT_ID || null,
    },
    data: {
      user: await executeFunction("users.me", {}),
      objectives: await executeFunction("objectives.getAllForCurrentUser", {}),
      initiatives: await executeFunction("initiatives.getAllForCurrentUser", {}),
    },
  };

  const initiativeId = process.env.OPENCLAW_INITIATIVE_ID;
  if (initiativeId) {
    try {
      result.data.initiativeImpact = await executeFunction("initiatives.getImpactDetails", {
        initiativeId,
      });
    } catch (error) {
      result.data.initiativeImpactError =
        error instanceof Error ? error.message : "Unknown impact details error";
    }
  }

  console.log(JSON.stringify(result));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown script error";
  console.error(JSON.stringify({ error: message }));
  process.exit(1);
});
