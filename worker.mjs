#!/usr/bin/env node

const convexUrl = process.env.CONVEX_URL;
const workerId = process.env.WORKER_ID || `afw-${Date.now()}`;
const idleTimeoutMs = 300000;
const pollMs = Number(process.env.POLL_INTERVAL_MS || 2000);
const heartbeatIntervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 10000);
const requestTimeoutMs = Number(process.env.CONVEX_HTTP_TIMEOUT_MS || 20000);
const workspaceId = process.env.WORKSPACE_ID || "default";
const openClawEnabled = parseBooleanEnv(process.env.OPENCLAW_MVP_ENABLED, true);
const openClawTimeoutMs = Number(process.env.OPENCLAW_TIMEOUT_MS || 120000);
const openClawGatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const openClawGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";

if (!convexUrl) {
  console.error("[worker] FATAL: CONVEX_URL is required");
  process.exit(1);
}

let shuttingDown = false;
let lastActivityAt = Date.now();
let stickyConversationId = null;

process.on("SIGTERM", () => {
  console.log("[worker] SIGTERM received");
  shuttingDown = true;
});
process.on("SIGINT", () => {
  console.log("[worker] SIGINT received");
  shuttingDown = true;
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBooleanEnv(value, defaultValue) {
  if (value == null) return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function isRetryableError(error) {
  const message = String(error?.message || error);
  return /timeout|network|429|5\d\d/i.test(message);
}

async function convexCall(kind, path, args) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${convexUrl}/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Convex ${kind} ${path} failed [${response.status}]: ${bodyText}`);
    }

    const parsed = bodyText ? JSON.parse(bodyText) : {};
    if (parsed.status === "error") {
      throw new Error(parsed.errorMessage || `Convex ${kind} ${path} returned error`);
    }
    return parsed.value;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegramMessage(payload, text, botToken) {
  if (!botToken) {
    throw new Error("Bot not paired: missing telegram token in hydration bundle");
  }
  if (!payload || payload.provider !== "telegram") return;
  const chatId = payload.providerUserId;
  if (!chatId) return;

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram sendMessage failed: ${err}`);
  }
}

async function claimJob(conversationId) {
  return convexCall("mutation", "example:workerClaim", { workerId, conversationId });
}

async function hasQueuedConversation(conversationId) {
  return convexCall("query", "example:workerConversationHasQueued", { conversationId });
}

async function heartbeat(messageId, leaseId) {
  return convexCall("mutation", "example:workerHeartbeat", {
    workerId,
    messageId,
    leaseId,
  });
}

async function complete(messageId, leaseId) {
  return convexCall("mutation", "example:workerComplete", {
    workerId,
    messageId,
    leaseId,
  });
}

async function fail(messageId, leaseId, errorMessage) {
  return convexCall("mutation", "example:workerFail", {
    workerId,
    messageId,
    leaseId,
    errorMessage,
  });
}

async function loadHydration(messageId) {
  return convexCall("query", "example:workerHydrationBundle", {
    messageId,
    workspaceId,
  });
}

async function appendConversationMessages(conversationId, messages) {
  return convexCall("mutation", "example:workerAppendConversationMessages", {
    conversationId,
    messages,
  });
}

function buildOpenClawPrompt(job, hydration) {
  const promptSections = hydration?.snapshot?.compiledPromptStack ?? [];
  const memoryWindow = hydration?.snapshot?.memoryWindow ?? [];
  const history = hydration?.conversationState?.contextHistory ?? [];
  const recentHistory = history.slice(-12);
  const incomingText = job?.payload?.messageText || "(empty message)";

  const sectionsText = promptSections
    .map((section) => `## ${section.section}\n${section.content}`)
    .join("\n\n");
  const memoryText = memoryWindow
    .map((row) => `- ${row.path}: ${row.excerpt}`)
    .join("\n");
  const historyText = recentHistory
    .map((row) => `${row.role.toUpperCase()}: ${row.content}`)
    .join("\n");

  return [
    "You are OpenClaw runtime for a multi-tenant worker.",
    sectionsText ? `\n[HydrationSections]\n${sectionsText}` : "",
    memoryText ? `\n[MemoryWindow]\n${memoryText}` : "",
    historyText ? `\n[ConversationHistory]\n${historyText}` : "",
    `\n[UserMessage]\n${incomingText}`,
    "\nReturn only the assistant reply text.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function waitForGatewayHttp(maxWaitMs = 60000) {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const r = await fetch(`${openClawGatewayUrl}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok || r.status === 404) {
        console.log(`[gateway] HTTP endpoint ready at ${openClawGatewayUrl}`);
        return;
      }
    } catch {}
    attempt++;
    const backoff = Math.min(1000 * 2 ** Math.min(attempt, 4), 8000);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    console.log(`[gateway] HTTP readiness check ${attempt} failed (retry in ${backoff}ms)`);
    await sleep(Math.min(backoff, remaining));
  }
  throw new Error(`gateway_unavailable: HTTP endpoint not ready at ${openClawGatewayUrl} within ${maxWaitMs}ms`);
}

async function sendAgentMessageHttp(prompt) {
  const headers = { "Content-Type": "application/json" };
  if (openClawGatewayToken) {
    headers["Authorization"] = `Bearer ${openClawGatewayToken}`;
  }
  headers["x-openclaw-agent-id"] = "main";

  const res = await fetch(`${openClawGatewayUrl}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "openclaw",
      input: prompt,
      stream: false,
    }),
    signal: AbortSignal.timeout(openClawTimeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`gateway_http_error: ${res.status} ${res.statusText} ${body}`);
  }

  const data = await res.json();
  const outputItem = data?.output?.find?.((o) => o.type === "message")
    ?? data?.output?.[0];
  const textContent = outputItem?.content?.find?.((c) => c.type === "output_text")
    ?? outputItem?.content?.[0];
  return textContent?.text || data?.output_text || data?.text || data?.content || JSON.stringify(data);
}

async function runOpenClawMvp(job, hydration) {
  const model = process.env.OPENCLAW_AGENT_MODEL
    || hydration.runtimeConfig?.["llm.primary.model"]
    || hydration.runtimeConfig?.model
    || "gpt-5";
  const prompt = buildOpenClawPrompt(job, hydration);
  const reply = await sendAgentMessageHttp(prompt);
  return { reply, model };
}

async function processJob(job, hydration) {
  const incomingText = job?.payload?.messageText || "(empty message)";
  const openClawResult = openClawEnabled
    ? await runOpenClawMvp(job, hydration)
    : { reply: `Processed by ${workerId}: ${incomingText}`, model: "-" };

  const replyText = openClawResult.reply.trim();
  await appendConversationMessages(job.conversationId, [
    { role: "user", content: incomingText, at: Date.now() },
    { role: "assistant", content: replyText, at: Date.now() + 1 },
  ]);
  await sendTelegramMessage(job?.payload, replyText, hydration?.telegramBotToken);
  console.log(`[worker] OpenClaw reply model=${openClawResult.model}`);
}

async function run() {
  console.log(`[worker] START workerId=${workerId}`);
  console.log(
    `[worker] env CONVEX_URL=${convexUrl ? "SET" : "MISSING"} WORKSPACE_ID=${workspaceId} OPENCLAW_MVP_ENABLED=${openClawEnabled} OPENCLAW_GATEWAY_URL=${openClawGatewayUrl}`,
  );

  if (openClawEnabled) {
    console.log("[worker] Waiting for gateway HTTP endpoint...");
    await waitForGatewayHttp();
  }

  while (!shuttingDown) {
    try {
      if (Date.now() - lastActivityAt > idleTimeoutMs) {
        console.log("[worker] Idle timeout reached, exiting");
        break;
      }

      const job = await claimJob(stickyConversationId ?? undefined);
      if (!job) {
        if (stickyConversationId) {
          const hasQueued = await hasQueuedConversation(stickyConversationId);
          if (hasQueued) {
            lastActivityAt = Date.now();
          }
        }
        await sleep(pollMs);
        continue;
      }

      if (!stickyConversationId) {
        stickyConversationId = job.conversationId;
        console.log(`[worker] Sticky conversation=${stickyConversationId}`);
      } else if (job.conversationId !== stickyConversationId) {
        throw new Error(
          `sticky_mismatch: expected ${stickyConversationId}, got ${job.conversationId}`,
        );
      }
      lastActivityAt = Date.now();
      console.log(`[worker] Claimed messageId=${job.messageId} conversation=${job.conversationId}`);

      const hydration = await loadHydration(job.messageId);
      if (!hydration) {
        throw new Error(`Missing hydration bundle for messageId=${job.messageId}`);
      }

      const beat = setInterval(() => {
        heartbeat(job.messageId, job.leaseId).catch((err) => {
          console.error(`[worker] heartbeat failed: ${err?.message || err}`);
        });
      }, heartbeatIntervalMs);

      try {
        await processJob(job, hydration);
        await complete(job.messageId, job.leaseId);
        console.log(`[worker] Completed messageId=${job.messageId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[worker] Job failed messageId=${job.messageId}: ${message}`);
        await fail(job.messageId, job.leaseId, message);
      } finally {
        clearInterval(beat);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[worker] loop error: ${message}`);
      await sleep(Math.max(5000, pollMs));
    }
  }

  console.log("[worker] Exit clean");
  process.exit(0);
}

run().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[worker] FATAL: ${message}`);
  process.exit(isRetryableError(err) ? 1 : 2);
});
