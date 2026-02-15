#!/usr/bin/env node

const userId = process.argv[2];
const message = process.argv[3];

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
const endpoint = `${bridgeUrl.replace(/\/$/, "")}/agent/execute`;

fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Agent-Service-Id": serviceId,
    "X-Agent-Service-Key": serviceKey,
    "X-Agent-App": appKey,
  },
  body: JSON.stringify({
    functionKey: "getOkrContext",
    args: {
      userId,
      message,
      tenantId: process.env.TENANT_ID || null,
    },
  }),
})
  .then(async (res) => {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
  })
  .then((data) => {
    console.log(JSON.stringify(data));
    process.exit(0);
  })
  .catch((err) => {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  });
