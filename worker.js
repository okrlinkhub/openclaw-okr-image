#!/usr/bin/env node

import { spawn } from "node:child_process";
import net from "node:net";

const convexUrl = process.env.CONVEX_URL;
const workerId = process.env.WORKER_ID || `afw-${Date.now()}`;
const idleTimeoutMs = Number(process.env.IDLE_TIMEOUT_MS || 30000);
const pollMs = Number(process.env.POLL_INTERVAL_MS || 2000);
const heartbeatIntervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 10000);
const requestTimeoutMs = Number(process.env.CONVEX_HTTP_TIMEOUT_MS || 20000);
const workspaceId = process.env.WORKSPACE_ID || "default";
const openClawEnabled = parseBooleanEnv(process.env.OPENCLAW_MVP_ENABLED, true);
const openClawCommand = process.env.OPENCLAW_COMMAND || "/app/openclaw.mjs";
const openClawTimeoutMs = Number(process.env.OPENCLAW_TIMEOUT_MS || 120000);
const openClawThinking = process.env.OPENCLAW_THINKING || "medium";
const openClawGatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const openClawGatewayCheckTimeoutMs = Number(process.env.OPENCLAW_GATEWAY_CHECK_TIMEOUT_MS || 2500);
const openClawGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";

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

function inferProviderFromModel(model) {
  if (!model) return "openai";
  const lower = String(model).toLowerCase();
  if (lower.includes("/")) return lower.split("/")[0];
  if (lower.includes("claude")) return "anthropic";
  if (lower.includes("gemini")) return "google";
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3")) return "openai";
  return "openai";
}

function parseLlmPolicy(runtimeConfig) {
  const model = runtimeConfig?.["llm.primary.model"] || runtimeConfig?.model || "gpt-5";
  const provider =
    runtimeConfig?.["llm.primary.provider"] || inferProviderFromModel(model);

  let fallbacks = [];
  const rawFallbacks = runtimeConfig?.["llm.fallbacks"];
  if (typeof rawFallbacks === "string" && rawFallbacks.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawFallbacks);
      if (Array.isArray(parsed)) {
        fallbacks = parsed
          .map((entry) => ({
            provider: entry?.provider ? String(entry.provider).toLowerCase() : null,
            model: entry?.model ? String(entry.model) : null,
          }))
          .filter((entry) => entry.provider && entry.model);
      }
    } catch {
      // ignore invalid fallback config and continue with primary only
    }
  }

  return {
    primary: { provider: String(provider).toLowerCase(), model: String(model) },
    fallbacks,
    params: {
      temperature: runtimeConfig?.["llm.params.temperature"],
      maxTokens: runtimeConfig?.["llm.params.maxTokens"],
      timeoutMs: runtimeConfig?.["llm.params.timeoutMs"],
    },
  };
}

function buildProviderAttempts(policy) {
  const entries = [policy.primary, ...policy.fallbacks];
  const seen = new Set();
  const attempts = [];
  for (const entry of entries) {
    if (!entry?.provider || !entry?.model) continue;
    const key = `${entry.provider}:${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attempts.push(entry);
  }
  return attempts;
}

function resolveProviderApiKey(provider, agentKey, secretValues) {
  const refs = [
    `${provider}.apiKey.${agentKey}`,
    `${provider}.apiKey`,
    `${provider}.key.${agentKey}`,
    `${provider}.key`,
  ];
  for (const ref of refs) {
    const value = secretValues?.[ref];
    if (value) return value;
  }
  return null;
}

function providerEnv(provider, apiKey) {
  const out = {};
  out.OPENCLAW_GATEWAY_URL = openClawGatewayUrl;
  out.OPENCLAW_GATEWAY = openClawGatewayUrl;
  out.OPENCLAW_GATEWAY_BASE_URL = openClawGatewayUrl;
  if (openClawGatewayToken) {
    out.OPENCLAW_GATEWAY_TOKEN = openClawGatewayToken;
    out.OPENCLAW_GATEWAY_AUTH_TOKEN = openClawGatewayToken;
  }
  if (!apiKey) return out;
  switch (provider) {
    case "openai":
      out.OPENAI_API_KEY = apiKey;
      break;
    case "anthropic":
      out.ANTHROPIC_API_KEY = apiKey;
      break;
    case "google":
      out.GOOGLE_API_KEY = apiKey;
      out.GEMINI_API_KEY = apiKey;
      break;
    default:
      out[`${provider.toUpperCase()}_API_KEY`] = apiKey;
  }
  return out;
}

async function ensureGatewayReady() {
  let parsed;
  try {
    parsed = new URL(openClawGatewayUrl);
  } catch {
    return false;
  }
  const host = parsed.hostname || "127.0.0.1";
  const port = parsed.port ? Number(parsed.port) : 18789;
  if (!Number.isFinite(port) || port <= 0) return false;

  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(openClawGatewayCheckTimeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function shouldTryNextProvider(error) {
  const message = String(error?.message || error);
  return /timeout|network|429|5\d\d|rate|temporar|missing api key/i.test(message);
}

async function runOpenClawAttempt({ attempt, prompt, hydration }) {
  const apiKey = resolveProviderApiKey(
    attempt.provider,
    hydration.agentKey,
    hydration.secretValues,
  );
  if (!apiKey) {
    throw new Error(`missing api key for provider '${attempt.provider}'`);
  }

  const gatewayReady = await ensureGatewayReady();
  if (!gatewayReady) {
    throw new Error(`gateway_unavailable: cannot reach ${openClawGatewayUrl}`);
  }

  // Keep CLI invocation minimal for cross-version compatibility.
  // Provider/model selection is still passed via environment variables.
  const args = ["agent", "--message", prompt];

  return new Promise((resolve, reject) => {
    const child = spawn(openClawCommand, args, {
      env: {
        ...process.env,
        OPENCLAW_PROVIDER: attempt.provider,
        OPENCLAW_MODEL: attempt.model,
        ...providerEnv(attempt.provider, apiKey),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let closed = false;
    const timeout = setTimeout(() => {
      if (closed) return;
      child.kill("SIGKILL");
      reject(new Error(`OpenClaw timeout for ${attempt.provider}/${attempt.model}`));
    }, openClawTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`OpenClaw spawn failed: ${error.message}`));
    });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            `OpenClaw exit ${code} for ${attempt.provider}/${attempt.model}: ${stderr || stdout || "no output"}`,
          ),
        );
        return;
      }
      const replyText = stdout.trim();
      if (!replyText) {
        reject(new Error(`OpenClaw empty output for ${attempt.provider}/${attempt.model}`));
        return;
      }
      resolve(replyText);
    });
  });
}

async function runOpenClawMvp(job, hydration) {
  const policy = parseLlmPolicy(hydration.runtimeConfig || {});
  const attempts = buildProviderAttempts(policy);
  if (attempts.length === 0) {
    throw new Error("all_providers_failed: no llm attempts configured");
  }

  const prompt = buildOpenClawPrompt(job, hydration);
  const errors = [];
  for (const attempt of attempts) {
    try {
      const reply = await runOpenClawAttempt({ attempt, prompt, hydration });
      return {
        reply,
        provider: attempt.provider,
        model: attempt.model,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${attempt.provider}/${attempt.model}: ${message}`);
      if (!shouldTryNextProvider(error)) {
        break;
      }
    }
  }
  throw new Error(`all_providers_failed: ${errors.join(" | ")}`);
}

async function processJob(job, hydration) {
  const incomingText = job?.payload?.messageText || "(empty message)";
  const openClawResult = openClawEnabled
    ? await runOpenClawMvp(job, hydration)
    : { reply: `Processed by ${workerId}: ${incomingText}`, provider: "placeholder", model: "-" };

  const replyText = openClawResult.reply.trim();
  await appendConversationMessages(job.conversationId, [
    { role: "user", content: incomingText, at: Date.now() },
    { role: "assistant", content: replyText, at: Date.now() + 1 },
  ]);
  await sendTelegramMessage(job?.payload, replyText, hydration?.telegramBotToken);
  console.log(
    `[worker] OpenClaw reply provider=${openClawResult.provider} model=${openClawResult.model}`,
  );
}

async function run() {
  console.log(`[worker] START workerId=${workerId}`);
  console.log(
    `[worker] env CONVEX_URL=${convexUrl ? "SET" : "MISSING"} WORKSPACE_ID=${workspaceId} OPENCLAW_MVP_ENABLED=${openClawEnabled} OPENCLAW_GATEWAY_URL=${openClawGatewayUrl} OPENCLAW_COMMAND=${openClawCommand}`,
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
