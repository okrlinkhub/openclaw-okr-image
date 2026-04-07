#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, extname } from "node:path";

const convexUrl = process.env.CONVEX_URL;
const workerId = process.env.WORKER_ID || `afw-${Date.now()}`;
const idleTimeoutMs = Number(process.env.WORKER_IDLE_TIMEOUT_MS || 1800000);
const pollMs = Number(process.env.POLL_INTERVAL_MS || 2000);
const heartbeatIntervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 10000);
const requestTimeoutMs = Number(process.env.CONVEX_HTTP_TIMEOUT_MS || 20000);
const workspaceId = process.env.WORKSPACE_ID || "default";
const openClawEnabled = parseBooleanEnv(process.env.OPENCLAW_MVP_ENABLED, true);
const openClawTimeoutMs = Number(process.env.OPENCLAW_TIMEOUT_MS || 120000);
const openClawThinking = process.env.OPENCLAW_THINKING || "medium";
const openClawGatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const openClawAgentModel = process.env.OPENCLAW_AGENT_MODEL || "";
const openClawGatewayConnectTimeoutMs = Number(
  process.env.OPENCLAW_GATEWAY_CONNECT_TIMEOUT_MS || 60000,
);
const openClawStateDir = process.env.OPENCLAW_STATE_DIR || "/data/.clawdbot";
const openClawWorkspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
const openClawConfigPath = process.env.OPENCLAW_CONFIG_PATH || `${openClawStateDir}/openclaw.json`;
const openClawGatewayToken = resolveGatewayToken();
const openClawAgentKey = process.env.OPENCLAW_AGENT_KEY || "default";
const convexComponentName = process.env.AGENT_FACTORY_FUNCTION_NAMESPACE || "agentFactory";

if (!convexUrl) {
  console.error("[worker] FATAL: CONVEX_URL is required");
  process.exit(1);
}
if (typeof WebSocket === "undefined") {
  console.error("[worker] FATAL: WebSocket is unavailable in this Node runtime");
  process.exit(1);
}

let shuttingDown = false;
let shutdownReason = null;
let lastActivityAt = Date.now();
let stickyConversationId = null;
let stickyAgentKey = openClawAgentKey;
let snapshotCreatedForShutdown = false;
let controlCheckCount = 0;
let emptyPollCount = 0;

function formatRuntimeState() {
  return `workerId=${workerId} shuttingDown=${shuttingDown} shutdownReason=${shutdownReason ?? "none"} stickyConversationId=${stickyConversationId ?? "none"} stickyAgentKey=${stickyAgentKey ?? "none"} lastActivityAt=${lastActivityAt}`;
}

process.on("SIGTERM", () => {
  console.warn(`[worker] SIGTERM received ${formatRuntimeState()}`);
  shuttingDown = true;
  shutdownReason = "signal";
});
process.on("SIGINT", () => {
  console.warn(`[worker] SIGINT received ${formatRuntimeState()}`);
  shuttingDown = true;
  shutdownReason = "signal";
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBooleanEnv(value, defaultValue) {
  if (value == null) return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function resolveGatewayToken() {
  try {
    const raw = readFileSync(openClawConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    const configToken = parsed?.gateway?.auth?.token;
    if (typeof configToken === "string" && configToken.trim()) {
      return configToken.trim();
    }
  } catch {
    // fall through to env fallback
  }
  return String(process.env.OPENCLAW_GATEWAY_TOKEN || "").trim();
}

function isRetryableError(error) {
  const message = String(error?.message || error);
  return /timeout|network|429|5\d\d/i.test(message);
}

function convexComponentPath(functionName) {
  return `${convexComponentName}:${functionName}`;
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
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram sendMessage failed: ${err}`);
  }
}

function resolveTelegramChatId(payload) {
  if (!payload || payload.provider !== "telegram") return null;
  return payload?.metadata?.telegramChatId || payload.providerUserId || null;
}

function mimeTypeForAudioPath(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".aac") return "audio/aac";
  if (ext === ".flac") return "audio/flac";
  return "application/octet-stream";
}

async function sendTelegramAudioFromPath(payload, filePath, botToken, caption) {
  if (!botToken) {
    throw new Error("Bot not paired: missing telegram token in hydration bundle");
  }
  if (!payload || payload.provider !== "telegram") return false;
  if (!filePath || !existsSync(filePath)) return false;
  const chatId = resolveTelegramChatId(payload);
  if (!chatId) return false;

  const buffer = readFileSync(filePath);
  const form = new FormData();
  form.set("chat_id", chatId);
  if (typeof caption === "string" && caption.trim()) {
    form.set("caption", caption.trim().slice(0, 1024));
    form.set("parse_mode", "HTML");
  }
  form.set(
    "audio",
    new Blob([buffer], { type: mimeTypeForAudioPath(filePath) }),
    basename(filePath),
  );

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendAudio`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram sendAudio failed: ${err}`);
  }
  return true;
}

function extractAudioPathsFromText(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const matches = text.match(/\/tmp\/[^\s"'`]+?\.(?:mp3|wav|ogg|m4a|aac|flac)/gi) || [];
  return [...new Set(matches)];
}

function extractAudioPathsFromPayload(payload) {
  const candidates = [];
  if (typeof payload?.result === "string") candidates.push(payload.result);
  if (typeof payload?.result?.text === "string") candidates.push(payload.result.text);
  if (typeof payload?.result?.message === "string") candidates.push(payload.result.message);
  if (typeof payload?.output === "string") candidates.push(payload.output);
  if (typeof payload?.text === "string") candidates.push(payload.text);
  return [...new Set(candidates.flatMap((value) => extractAudioPathsFromText(value)))];
}

function stripMediaControlLines(text) {
  if (typeof text !== "string") return "";
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^MEDIA:\s*\/tmp\//i.test(trimmed)) return false;
      if (/^send\s*[·-]\s*\/tmp\//i.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

async function fetchTelegramFileBlob(botToken, fileId) {
  const fileResp = await fetch(`https://api.telegram.org/bot${botToken}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const fileJson = await fileResp.json();
  if (!fileResp.ok || !fileJson?.ok || !fileJson?.result?.file_path) {
    throw new Error(`Telegram getFile failed for ${fileId}`);
  }

  const filePath = fileJson.result.file_path;
  const downloadResp = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
  if (!downloadResp.ok) {
    throw new Error(`Telegram file download failed for ${fileId}`);
  }
  const contentType = downloadResp.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await downloadResp.arrayBuffer());
  return { buffer, contentType, filePath };
}

async function uploadBlobToConvexStorage(buffer, contentType) {
  const { uploadUrl } = await convexCall(
    "mutation",
    convexComponentPath("workerGenerateMediaUploadUrl"),
    {},
  );
  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: buffer,
  });
  const uploadText = await uploadResp.text();
  if (!uploadResp.ok) {
    throw new Error(`Convex media upload failed [${uploadResp.status}]: ${uploadText}`);
  }
  const parsed = uploadText ? JSON.parse(uploadText) : {};
  if (!parsed.storageId) {
    throw new Error("Convex media upload missing storageId");
  }
  const storageUrl = await convexCall("query", convexComponentPath("workerGetStorageFileUrl"), {
    storageId: parsed.storageId,
  });
  return { storageId: parsed.storageId, storageUrl };
}

async function claimJob(conversationId) {
  return convexCall("mutation", convexComponentPath("workerClaim"), { workerId, conversationId });
}

async function hasQueuedConversation(conversationId) {
  return convexCall("query", convexComponentPath("workerConversationHasQueued"), { conversationId });
}

async function heartbeat(messageId, leaseId) {
  return convexCall("mutation", convexComponentPath("workerHeartbeat"), { workerId, messageId, leaseId });
}

async function complete(messageId, leaseId) {
  return convexCall("mutation", convexComponentPath("workerComplete"), { workerId, messageId, leaseId });
}

async function fail(messageId, leaseId, errorMessage) {
  return convexCall("mutation", convexComponentPath("workerFail"), {
    workerId,
    messageId,
    leaseId,
    errorMessage,
  });
}

async function loadHydration(messageId) {
  return convexCall("query", convexComponentPath("workerHydrationBundle"), { messageId, workspaceId });
}

async function appendConversationMessages(conversationId, messages) {
  return convexCall("mutation", convexComponentPath("workerAppendConversationMessages"), {
    conversationId,
    workspaceId,
    messages,
  });
}

async function getWorkerControlState() {
  return convexCall("query", convexComponentPath("workerControlState"), { workerId });
}

async function prepareSnapshotUpload({ reason, conversationId }) {
  return convexCall("mutation", convexComponentPath("workerPrepareSnapshotUpload"), {
    workerId,
    workspaceId,
    agentKey: stickyAgentKey || openClawAgentKey,
    conversationId,
    reason,
  });
}

async function finalizeSnapshotUpload(snapshotId, storageId, sha256, sizeBytes) {
  return convexCall("mutation", convexComponentPath("workerFinalizeSnapshotUpload"), {
    workerId,
    snapshotId,
    storageId,
    sha256,
    sizeBytes,
  });
}

async function failSnapshotUpload(snapshotId, error) {
  return convexCall("mutation", convexComponentPath("workerFailSnapshotUpload"), {
    workerId,
    snapshotId,
    error,
  });
}

async function getLatestSnapshotForRestore() {
  return convexCall("query", convexComponentPath("workerLatestSnapshotForRestore"), {
    workspaceId,
    agentKey: stickyAgentKey || openClawAgentKey,
  });
}

async function attachMessageMetadata(messageId, metadata) {
  if (!metadata || Object.keys(metadata).length === 0) return;
  await convexCall("mutation", convexComponentPath("workerAttachMessageMetadata"), {
    messageId,
    metadata,
  });
}

function sanitizeAttachmentFileName(fileName, fallbackBaseName) {
  const rawName = typeof fileName === "string" ? fileName.trim() : "";
  const sanitized = rawName
    .replaceAll("\\", "-")
    .replaceAll("/", "-")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || fallbackBaseName;
}

function extensionFromMimeType(mimeType) {
  const normalized = typeof mimeType === "string" ? mimeType.toLowerCase().trim() : "";
  if (!normalized) return "";
  const mimeToExt = {
    "application/pdf": ".pdf",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "text/csv": ".csv",
    "text/markdown": ".md",
    "text/plain": ".txt",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
  };
  return mimeToExt[normalized] || "";
}

function resolveAttachmentFileName(attachment, index) {
  const baseName = sanitizeAttachmentFileName(
    attachment?.fileName,
    `${attachment?.kind || "attachment"}-${index + 1}`,
  );
  if (extname(baseName)) return baseName;
  const extension = extensionFromMimeType(attachment?.mimeType);
  return extension ? `${baseName}${extension}` : baseName;
}

async function writeHydratedAttachmentToWorkspace(messageId, attachment, index) {
  const downloadUrl = typeof attachment?.downloadUrl === "string" ? attachment.downloadUrl : "";
  if (!downloadUrl) return null;

  const fileName = resolveAttachmentFileName(attachment, index);
  const attachmentsDir = `${openClawWorkspaceDir}/.telegram-attachments/${messageId}`;
  const filePath = `${attachmentsDir}/${fileName}`;
  mkdirSync(attachmentsDir, { recursive: true });

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Attachment download failed [${response.status}]`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(filePath, buffer);
  return { filePath, fileName, sizeBytes: buffer.length };
}

async function materializeTelegramMedia(job, hydration) {
  const hydratedAttachments = Array.isArray(hydration?.payload?.attachments)
    ? hydration.payload.attachments.filter(
        (attachment) =>
          attachment &&
          attachment.status === "ready" &&
          typeof attachment.downloadUrl === "string" &&
          attachment.downloadUrl.length > 0,
      )
    : [];
  if (hydratedAttachments.length > 0) {
    const lines = [];
    const nextMetadata = {};
    for (const [index, attachment] of hydratedAttachments.entries()) {
      try {
        const materialized = await writeHydratedAttachmentToWorkspace(job.messageId, attachment, index);
        if (!materialized) continue;
        const label = attachment.kind === "voice" ? "audio (voice)" : attachment.kind || "attachment";
        const details = [
          materialized.filePath,
          attachment.fileName ? `filename=${attachment.fileName}` : null,
          attachment.mimeType ? `mime=${attachment.mimeType}` : null,
          typeof attachment.downloadUrl === "string" ? `url=${attachment.downloadUrl}` : null,
        ]
          .filter(Boolean)
          .join(" | ");
        lines.push(`- ${label}: ${details}`);
        if (typeof attachment.storageId === "string" && attachment.storageId.length > 0) {
          nextMetadata[`convexAttachmentStorageId${index + 1}`] = attachment.storageId;
        }
        nextMetadata[`convexAttachmentPath${index + 1}`] = materialized.filePath;
      } catch (error) {
        console.error(
          `[worker] hydrated attachment materialization failed (${attachment?.kind || "attachment"}): ${error?.message || error}`,
        );
      }
    }
    return { lines, metadata: nextMetadata };
  }

  const metadata = job?.payload?.metadata || {};
  const botToken = hydration?.telegramBotToken;
  if (!botToken) return { lines: [], metadata: {} };

  const mediaSpecs = [
    { kind: "photo", fileId: metadata.telegramPhotoFileId },
    { kind: "video", fileId: metadata.telegramVideoFileId },
    { kind: "audio", fileId: metadata.telegramAudioFileId },
    { kind: "voice", fileId: metadata.telegramVoiceFileId },
  ].filter((item) => typeof item.fileId === "string" && item.fileId.length > 0);

  const lines = [];
  const nextMetadata = {};
  for (const media of mediaSpecs) {
    try {
      const { buffer, contentType } = await fetchTelegramFileBlob(botToken, media.fileId);
      const uploaded = await uploadBlobToConvexStorage(buffer, contentType);
      if (!uploaded.storageUrl) continue;
      const label = media.kind === "voice" ? "audio (voice)" : media.kind;
      lines.push(`- ${label}: ${uploaded.storageUrl}`);
      const keyBase = media.kind[0].toUpperCase() + media.kind.slice(1);
      nextMetadata[`convex${keyBase}StorageId`] = uploaded.storageId;
      nextMetadata[`convex${keyBase}Url`] = uploaded.storageUrl;
    } catch (error) {
      console.error(`[worker] media upload failed (${media.kind}): ${error?.message || error}`);
    }
  }
  return { lines, metadata: nextMetadata };
}

function buildOpenClawPrompt(job, hydration) {
  const history = hydration?.conversationState?.contextHistory ?? [];
  const recentHistory = history.slice(-12);
  const incomingText = job?.payload?.messageText || "(empty message)";
  const historyText = recentHistory
    .map((row) => `${row.role.toUpperCase()}: ${row.content}`)
    .join("\n");
  return [
    "You are OpenClaw runtime for a multi-tenant worker.",
    "If the user message includes a [telegram_media] section, inspect every referenced local file path before answering.",
    "Treat document attachments as primary source material and use filenames, MIME types, and linked files to answer accurately.",
    historyText ? `\n[ConversationHistory]\n${historyText}` : "",
    `\n[UserMessage]\n${incomingText}`,
    "\nReturn only the assistant reply text.",
  ]
    .filter(Boolean)
    .join("\n");
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function base64UrlEncode(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
function derivePublicKeyRaw(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}
function loadOrCreateDeviceIdentity(filePath) {
  try {
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (
        parsed &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKeyPem === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        return parsed;
      }
    }
  } catch {
    // regenerate
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const deviceId = createHash("sha256").update(derivePublicKeyRaw(publicKeyPem)).digest("hex");
  const identity = { version: 1, deviceId, publicKeyPem, privateKeyPem };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}
function buildDeviceAuthPayload(params) {
  const version = params.nonce ? "v2" : "v1";
  const fields = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token || "",
  ];
  if (version === "v2") fields.push(params.nonce || "");
  return fields.join("|");
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function isDirEffectivelyEmpty(path) {
  if (!existsSync(path)) return true;
  try {
    const entries = readdirSync(path);
    if (entries.length === 0) return true;
    if (entries.length === 1 && entries[0] === ".gitkeep") return true;
    return false;
  } catch {
    return true;
  }
}

function hasMeaningfulOpenClawState() {
  const sessionsPath = `${openClawStateDir}/agents/main/sessions/sessions.json`;
  if (existsSync(sessionsPath)) {
    try {
      const raw = readFileSync(sessionsPath, "utf8").trim();
      if (raw && raw !== "{}") {
        return true;
      }
    } catch {
      return false;
    }
  }
  return !isDirEffectivelyEmpty(openClawWorkspaceDir);
}

async function restoreSnapshotIfNeeded() {
  if (hasMeaningfulOpenClawState()) {
    return;
  }
  const restore = await getLatestSnapshotForRestore();
  if (!restore?.downloadUrl) return;
  const archivePath = `/tmp/${workerId}-restore-${Date.now()}.tar.gz`;
  const response = await fetch(restore.downloadUrl);
  if (!response.ok) {
    throw new Error(`restore download failed: ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(archivePath, bytes);
  const downloadedSha = createHash("sha256").update(bytes).digest("hex");
  if (restore.sha256 && restore.sha256 !== downloadedSha) {
    throw new Error("restore checksum mismatch");
  }
  mkdirSync("/data", { recursive: true });
  await runCommand("tar", ["-xzf", archivePath, "-C", "/data"]);
  rmSync(archivePath, { force: true });
  console.log(`[worker] Restored snapshot ${restore.snapshotId}`);
}

async function createAndUploadSnapshot(reason) {
  const archivePath = `/tmp/${workerId}-${Date.now()}-${reason}.tar.gz`;
  const upload = await prepareSnapshotUpload({
    reason,
    conversationId: stickyConversationId ?? undefined,
  });
  try {
    await runCommand("tar", [
      "-czf",
      archivePath,
      "-C",
      "/data",
      ".clawdbot",
      "workspace",
    ]);
    const payload = readFileSync(archivePath);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const uploadResponse = await fetch(upload.uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/gzip",
      },
      body: payload,
    });
    const uploadBody = await uploadResponse.text();
    if (!uploadResponse.ok) {
      throw new Error(`snapshot upload failed [${uploadResponse.status}]: ${uploadBody}`);
    }
    const parsed = uploadBody ? JSON.parse(uploadBody) : {};
    if (!parsed.storageId) {
      throw new Error("snapshot upload missing storageId");
    }
    await finalizeSnapshotUpload(upload.snapshotId, parsed.storageId, sha256, payload.length);
    snapshotCreatedForShutdown = true;
    console.log(`[worker] Snapshot uploaded snapshotId=${upload.snapshotId} reason=${reason}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failSnapshotUpload(upload.snapshotId, message);
    throw error;
  } finally {
    rmSync(archivePath, { force: true });
  }
}

class GatewayClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.pending = new Map();
    this.runText = new Map();
    this.connectInFlight = null;
    this.identity = loadOrCreateDeviceIdentity(`${openClawStateDir}/identity/worker-device.json`);
  }

  wsUrl() {
    return openClawGatewayUrl.startsWith("http://")
      ? `ws://${openClawGatewayUrl.slice(7)}`
      : openClawGatewayUrl.startsWith("https://")
      ? `wss://${openClawGatewayUrl.slice(8)}`
      : openClawGatewayUrl;
  }

  async ensureConnected() {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectInFlight) return this.connectInFlight;
    this.connectInFlight = this.connect();
    try {
      await this.connectInFlight;
    } finally {
      this.connectInFlight = null;
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl());
      this.ws = ws;
      let connectSettled = false;
      const failBeforeConnect = (reason) => {
        if (connectSettled) return;
        connectSettled = true;
        reject(new Error(reason));
        try {
          ws.close();
        } catch {
          // ignore
        }
      };
      const timer = setTimeout(() => {
        failBeforeConnect("gateway_connect_timeout");
      }, openClawGatewayConnectTimeoutMs);

      ws.addEventListener("message", (event) => {
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (frame?.type === "event" && frame?.event === "connect.challenge") {
          const scopes = ["operator.admin", "operator.read", "operator.write"];
          // OpenClaw gateway (v2026.3.x) accepts token-authenticated connect without device signature.
          // Sending legacy device payload can trigger policy-close (1008) before hello-ok.
          ws.send(
            JSON.stringify({
              type: "req",
              id: randomUUID(),
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: "gateway-client",
                  version: "1.0.0",
                  platform: "linux",
                  mode: "backend",
                },
                role: "operator",
                scopes,
                auth: openClawGatewayToken ? { token: openClawGatewayToken } : undefined,
              },
            }),
          );
          return;
        }

        if (!this.connected && frame?.type === "res" && frame?.ok && frame?.payload?.type === "hello-ok") {
          clearTimeout(timer);
          connectSettled = true;
          this.connected = true;
          resolve();
          return;
        }

        if (frame?.type === "event" && frame?.event === "agent") {
          const runId = frame?.payload?.runId;
          const text = frame?.payload?.data?.text;
          if (typeof runId === "string" && typeof text === "string") {
            this.runText.set(runId, text);
          }
          return;
        }

        if (frame?.type === "res" && typeof frame?.id === "string") {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          if (pending.expectFinal && frame?.payload?.status === "accepted") return;
          this.pending.delete(frame.id);
          if (frame.ok) pending.resolve(frame.payload);
          else pending.reject(new Error(frame?.error?.message || "gateway request failed"));
        }
      });

      ws.addEventListener("close", () => {
        clearTimeout(timer);
        const wasConnected = this.connected;
        this.connected = false;
        for (const [, pending] of this.pending) {
          pending.reject(new Error("gateway socket closed"));
        }
        this.pending.clear();
        if (!wasConnected) {
          failBeforeConnect("gateway_socket_closed_before_connect");
        }
      });

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        const wasConnected = this.connected;
        this.connected = false;
        if (!wasConnected) {
          failBeforeConnect("gateway_socket_error_before_connect");
        }
      });
    });
  }

  async request(method, params, { expectFinal = false, timeoutMs = 30000 } = {}) {
    await this.ensureConnected();
    return await new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway timeout for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        expectFinal,
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  extractReplyText(payload) {
    if (typeof payload?.result === "string" && payload.result.trim()) return payload.result.trim();
    if (typeof payload?.result?.text === "string" && payload.result.text.trim()) {
      return payload.result.text.trim();
    }
    if (typeof payload?.runId === "string") {
      const streamedText = this.runText.get(payload.runId);
      if (typeof streamedText === "string" && streamedText.trim()) return streamedText.trim();
    }
    return "";
  }
}

const gatewayClient = new GatewayClient();

async function runOpenClawAttempt({ attempt, prompt }) {
  const payload = await gatewayClient.request(
    "agent",
    {
      message: prompt,
      agentId: "main",
      thinking: openClawThinking,
      idempotencyKey: randomUUID(),
    },
    { expectFinal: true, timeoutMs: openClawTimeoutMs },
  );
  const reply = gatewayClient.extractReplyText(payload);
  if (!reply) {
    throw new Error(`OpenClaw empty output for ${attempt.provider}/${attempt.model}`);
  }
  const runText = typeof payload?.runId === "string" ? gatewayClient.runText.get(payload.runId) : "";
  const audioPaths = [
    ...extractAudioPathsFromPayload(payload),
    ...extractAudioPathsFromText(runText),
    ...extractAudioPathsFromText(reply),
  ];
  return { reply, payload, audioPaths: [...new Set(audioPaths)] };
}

async function runOpenClawMvp(job, hydration) {
  const prompt = buildOpenClawPrompt(job, hydration);
  const attemptResult = await runOpenClawAttempt({ attempt: null, prompt });
  return {
    ...attemptResult,
    provider: "gateway",
    model: openClawAgentModel || "configured",
  };
}

async function processJob(job, hydration) {
  const incomingText = job?.payload?.messageText || "(empty message)";
  const media = await materializeTelegramMedia(job, hydration);
  if (Object.keys(media.metadata).length > 0) {
    await attachMessageMetadata(job.messageId, media.metadata);
  }
  const enrichedIncomingText = media.lines.length
    ? `${incomingText}\n\n[telegram_media]\n${media.lines.join("\n")}`
    : incomingText;
  const openClawResult = openClawEnabled
    ? await runOpenClawMvp(
        {
          ...job,
          payload: {
            ...job.payload,
            messageText: enrichedIncomingText,
          },
        },
        hydration,
      )
    : {
        reply: `Processed by ${workerId}: ${enrichedIncomingText}`,
        payload: null,
        audioPaths: [],
        provider: "placeholder",
        model: "-",
      };
  const replyText = stripMediaControlLines(openClawResult.reply);
  const audioPath = openClawResult.audioPaths.find((path) => existsSync(path));
  await appendConversationMessages(job.conversationId, [
    { role: "user", content: enrichedIncomingText, at: Date.now() },
    { role: "assistant", content: replyText || "(audio)", at: Date.now() + 1 },
  ]);
  if (audioPath) {
    const sentAudio = await sendTelegramAudioFromPath(
      job?.payload,
      audioPath,
      hydration?.telegramBotToken,
      replyText || undefined,
    );
    if (sentAudio) {
      console.log(`[worker] Sent native Telegram audio: ${audioPath}`);
      if (!replyText || replyText.length <= 1024) {
        console.log(`[worker] OpenClaw reply provider=${openClawResult.provider} model=${openClawResult.model}`);
        return;
      }
    }
  }
  if (replyText) {
    await sendTelegramMessage(job?.payload, replyText, hydration?.telegramBotToken);
  }
  console.log(`[worker] OpenClaw reply provider=${openClawResult.provider} model=${openClawResult.model}`);
}

async function run() {
  console.log(`[worker] START workerId=${workerId}`);
  console.log(
    `[worker] env CONVEX_URL=${convexUrl ? "SET" : "MISSING"} WORKSPACE_ID=${workspaceId} OPENCLAW_MVP_ENABLED=${openClawEnabled} OPENCLAW_GATEWAY_URL=${openClawGatewayUrl} OPENCLAW_AGENT_MODEL=${openClawAgentModel || "-"}`,
  );
  while (!shuttingDown) {
    try {
      controlCheckCount += 1;
      const control = await getWorkerControlState();
      if (control.shouldStop) {
        console.warn(
          `[worker] control requested shutdown on check #${controlCheckCount} ${formatRuntimeState()}`,
        );
        shutdownReason = "signal";
        shuttingDown = true;
        continue;
      }
      if (Date.now() - lastActivityAt > idleTimeoutMs) {
        console.log("[worker] Idle timeout reached, exiting");
        shutdownReason = "manual";
        break;
      }
      const job = await claimJob(stickyConversationId ?? undefined);
      if (!job) {
        emptyPollCount += 1;
        if (emptyPollCount % 30 === 0) {
          console.log(
            `[worker] no job available poll=${emptyPollCount} controlChecks=${controlCheckCount} ${formatRuntimeState()}`,
          );
        }
        if (stickyConversationId) {
          const hasQueued = await hasQueuedConversation(stickyConversationId);
          if (hasQueued) lastActivityAt = Date.now();
        }
        await sleep(pollMs);
        continue;
      }
      emptyPollCount = 0;
      if (!stickyConversationId) {
        stickyConversationId = job.conversationId;
        stickyAgentKey = job.agentKey || stickyAgentKey;
        console.log(`[worker] Sticky conversation=${stickyConversationId}`);
      } else if (job.conversationId !== stickyConversationId) {
        throw new Error(`sticky_mismatch: expected ${stickyConversationId}, got ${job.conversationId}`);
      }
      lastActivityAt = Date.now();
      console.log(`[worker] Claimed messageId=${job.messageId} conversation=${job.conversationId}`);
      const hydration = await loadHydration(job.messageId);
      if (!hydration) throw new Error(`Missing hydration bundle for messageId=${job.messageId}`);

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
  if (!snapshotCreatedForShutdown) {
    try {
      console.log(
        `[worker] preparing shutdown snapshot reason=${shutdownReason === "signal" ? "signal" : "manual"} ${formatRuntimeState()}`,
      );
      await createAndUploadSnapshot(shutdownReason === "signal" ? "signal" : "manual");
    } catch (error) {
      console.error(
        `[worker] snapshot before exit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(`[worker] Exit clean ${formatRuntimeState()} controlChecks=${controlCheckCount}`);
  process.exit(0);
}

run().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[worker] FATAL: ${message}`);
  process.exit(isRetryableError(err) ? 1 : 2);
});
