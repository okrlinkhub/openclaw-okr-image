#!/usr/bin/env node

const convexUrl = process.env.CONVEX_URL;
const workerId = process.env.WORKER_ID || `afw-${Date.now()}`;
const idleTimeoutMs = Number(process.env.IDLE_TIMEOUT_MS || 30000);
const pollMs = Number(process.env.POLL_INTERVAL_MS || 2000);
const heartbeatIntervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 10000);
const requestTimeoutMs = Number(process.env.CONVEX_HTTP_TIMEOUT_MS || 20000);
const workspaceId = process.env.WORKSPACE_ID || "default";

if (!convexUrl) {
  console.error("[worker] FATAL: CONVEX_URL is required");
  process.exit(1);
}

let shuttingDown = false;
let lastActivityAt = Date.now();

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

async function claimJob() {
  return convexCall("mutation", "example:workerClaim", { workerId });
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

async function processJob(job, hydration) {
  // Placeholder minimal processing; replace with OpenClaw engine call if needed.
  const incomingText = job?.payload?.messageText || "(empty message)";
  const replyText = `Processed by ${workerId}: ${incomingText}`;
  await sendTelegramMessage(job?.payload, replyText, hydration?.telegramBotToken);
}

async function run() {
  console.log(`[worker] START workerId=${workerId}`);
  console.log(
    `[worker] env CONVEX_URL=${convexUrl ? "SET" : "MISSING"} WORKSPACE_ID=${workspaceId}`,
  );

  while (!shuttingDown) {
    try {
      if (Date.now() - lastActivityAt > idleTimeoutMs) {
        console.log("[worker] Idle timeout reached, exiting");
        break;
      }

      const job = await claimJob();
      if (!job) {
        await sleep(pollMs);
        continue;
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
