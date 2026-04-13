#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";

const convexUrl = process.env.CONVEX_URL;
const workerId = process.env.WORKER_ID || `afw-${Date.now()}`;
const requestTimeoutMs = Number(process.env.CONVEX_HTTP_TIMEOUT_MS || 20000);
const workspaceId = process.env.WORKSPACE_ID || "default";
const openClawStateDir = process.env.OPENCLAW_STATE_DIR || "/data/.clawdbot";
const openClawWorkspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
const openClawAgentKey = process.env.OPENCLAW_AGENT_KEY || "default";
const openClawConversationId = String(process.env.OPENCLAW_CONVERSATION_ID || "").trim();
const convexComponentName = process.env.AGENT_FACTORY_FUNCTION_NAMESPACE || "agentFactory";
const skillsBootstrapMode = process.env.SKILLS_BOOTSTRAP_MODE || "off";
const skillsBootstrapRequired = parseBooleanEnv(process.env.SKILLS_BOOTSTRAP_REQUIRED, false);
const skillsBootstrapTimeoutMs = Number(process.env.SKILLS_BOOTSTRAP_TIMEOUT_MS || 15000);
const globalSkillsReleaseChannel = process.env.SKILLS_RELEASE_CHANNEL || "stable";
const openClawSkillsDir = process.env.OPENCLAW_SKILLS_DIR || `${openClawWorkspaceDir}/skills`;
const bootstrapStatePath = `${openClawStateDir}/bootstrap/global-skills-state.json`;

if (!convexUrl) {
  console.error("[bootstrap] FATAL: CONVEX_URL is required");
  process.exit(1);
}

function log(message) {
  console.log(`[bootstrap] ${message}`);
}

function warn(message) {
  console.warn(`[bootstrap] WARN: ${message}`);
}

function parseBooleanEnv(value, defaultValue) {
  if (value == null) return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
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

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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

async function getLatestSnapshotForRestore() {
  if (!openClawConversationId) {
    log("Skipping snapshot restore lookup because OPENCLAW_CONVERSATION_ID is missing");
    return null;
  }
  return convexCall("query", convexComponentPath("workerLatestSnapshotForRestore"), {
    workspaceId,
    agentKey: openClawAgentKey,
    conversationId: openClawConversationId,
  });
}

async function restoreSnapshotIfNeeded() {
  if (hasMeaningfulOpenClawState()) {
    log("Skipping snapshot restore because /data already contains state");
    return { skipped: true, reason: "existing_state" };
  }
  const restore = await getLatestSnapshotForRestore();
  if (!restore?.downloadUrl) {
    log("No snapshot available for restore");
    return { skipped: true, reason: "missing_snapshot" };
  }
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
  log(`Restored snapshot ${restore.snapshotId}`);
  return { skipped: false, snapshotId: restore.snapshotId };
}

function ensureWorkspaceMemoryFiles() {
  mkdirSync(openClawWorkspaceDir, { recursive: true });
  const memoryDir = `${openClawWorkspaceDir}/memory`;
  mkdirSync(memoryDir, { recursive: true });

  const memoryPath = `${openClawWorkspaceDir}/MEMORY.md`;
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, "# Long-Term Memory\n\n");
    log("Seeded workspace MEMORY.md");
  }

  const dailyMemoryPath = `${memoryDir}/${new Date().toISOString().slice(0, 10)}.md`;
  if (!existsSync(dailyMemoryPath)) {
    writeFileSync(dailyMemoryPath, `# ${new Date().toISOString().slice(0, 10)}\n\n`);
    log(`Seeded workspace daily memory ${dailyMemoryPath}`);
  }
}

async function getWorkerGlobalSkillsManifest() {
  return convexCall("query", convexComponentPath("workerGlobalSkillsManifest"), {
    workspaceId,
    workerId,
    releaseChannel: globalSkillsReleaseChannel,
  });
}

function readBootstrapState() {
  if (!existsSync(bootstrapStatePath)) return null;
  try {
    return JSON.parse(readFileSync(bootstrapStatePath, "utf8"));
  } catch {
    return null;
  }
}

function writeBootstrapState(nextState) {
  mkdirSync(dirname(bootstrapStatePath), { recursive: true });
  writeFileSync(bootstrapStatePath, `${JSON.stringify(nextState, null, 2)}\n`);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toSafeSkillSlug(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-");
  return normalized || "unnamed-skill";
}

function normalizeRelativePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.includes("../")) {
    throw new Error(`invalid_relative_path:${value}`);
  }
  return normalized;
}

function getMaterializedFiles(rawSkill, slug) {
  const provided = Array.isArray(rawSkill?.files) ? rawSkill.files : [];
  if (provided.length === 0) {
    throw new Error(`global skill '${slug}' has no files bundle`);
  }
  const files = provided.map((file) => {
    const path = normalizeRelativePath(file?.path);
    const content = typeof file?.content === "string" ? file.content : "";
    const sha256 = typeof file?.sha256 === "string" && file.sha256.trim() ? file.sha256.trim() : sha256Hex(content);
    if (sha256 !== sha256Hex(content)) {
      throw new Error(`global skill checksum mismatch for ${slug}:${path}`);
    }
    return { path, content, sha256 };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error(`global skill '${slug}' contains duplicate file paths`);
  }
  const byPath = new Set(files.map((file) => file.path));
  const scriptExt = String(rawSkill?.moduleFormat || "esm") === "cjs" ? "cjs" : "mjs";
  const requiredPaths = ["SKILL.md", `scripts/index.${scriptExt}`, ".af-global-skill.json"];
  for (const requiredPath of requiredPaths) {
    if (!byPath.has(requiredPath)) {
      throw new Error(`global skill '${slug}' missing required file '${requiredPath}'`);
    }
  }
  return files;
}

function writeFileWithParents(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function replaceManagedSkillDir(skillDir, files) {
  const tempDir = `${skillDir}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const backupDir = `${skillDir}.bak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
  for (const file of files) {
    writeFileWithParents(`${tempDir}/${file.path}`, file.content);
  }

  let movedExisting = false;
  try {
    if (existsSync(skillDir)) {
      renameSync(skillDir, backupDir);
      movedExisting = true;
    }
    renameSync(tempDir, skillDir);
    if (movedExisting) {
      rmSync(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    if (!existsSync(skillDir) && movedExisting && existsSync(backupDir)) {
      renameSync(backupDir, skillDir);
    }
    throw error;
  }
}

function cleanupRemovedManagedSkills(skillsRoot, nextSkillSlugs) {
  let entries = [];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidateDir = `${skillsRoot}/${entry.name}`;
    const markerPath = `${candidateDir}/.af-global-skill.json`;
    if (!existsSync(markerPath)) continue;
    if (nextSkillSlugs.has(entry.name)) continue;
    rmSync(candidateDir, { recursive: true, force: true });
  }
}

async function materializeGlobalSkillsFromManifest(manifest) {
  const skills = Array.isArray(manifest?.skills) ? manifest.skills : [];
  mkdirSync(openClawSkillsDir, { recursive: true });
  const activeSkillSlugs = new Set();

  for (const rawSkill of skills) {
    const slug = toSafeSkillSlug(rawSkill?.skillDirName || rawSkill?.slug);
    const skillDir = `${openClawSkillsDir}/${slug}`;
    const hasUnmanagedDirectory = existsSync(skillDir) && !existsSync(`${skillDir}/.af-global-skill.json`);
    if (hasUnmanagedDirectory) {
      warn(`global skill '${slug}' skipped: unmanaged directory exists`);
      continue;
    }

    const files = getMaterializedFiles(rawSkill, slug);
    const expectedSha = typeof rawSkill?.sha256 === "string" ? rawSkill.sha256.trim() : "";
    const bundleSha = sha256Hex(
      files
        .filter((file) => file.path !== ".af-global-skill.json")
        .map((file) => `${file.path}\n${file.sha256}\n${file.content}`)
        .join("\n---\n"),
    );
    if (expectedSha && expectedSha !== bundleSha) {
      throw new Error(`global skill bundle checksum mismatch for ${slug}`);
    }
    replaceManagedSkillDir(skillDir, files);
    activeSkillSlugs.add(slug);
  }

  cleanupRemovedManagedSkills(openClawSkillsDir, activeSkillSlugs);

  const lockfile = {
    layoutVersion: String(manifest?.layoutVersion || "legacy"),
    manifestVersion: String(manifest?.manifestVersion || "unknown"),
    generatedAt: Number(manifest?.generatedAt || Date.now()),
    releaseChannel: String(manifest?.releaseChannel || globalSkillsReleaseChannel),
    skillsDir: openClawSkillsDir,
    skillsCount: activeSkillSlugs.size,
    skills: [...activeSkillSlugs].sort(),
    workspaceId,
    workerId,
  };
  writeFileSync(`${openClawSkillsDir}/.skills.lock.json`, `${JSON.stringify(lockfile, null, 2)}\n`);
  return lockfile;
}

async function bootstrapGlobalSkillsIfConfigured() {
  if (skillsBootstrapMode !== "db_manifest") {
    log(`Skills bootstrap skipped (mode=${skillsBootstrapMode})`);
    writeBootstrapState({
      source: "db_manifest",
      status: "skipped",
      required: skillsBootstrapRequired,
      skippedAt: Date.now(),
      reason: `mode_${skillsBootstrapMode}`,
      skillsDir: openClawSkillsDir,
      releaseChannel: globalSkillsReleaseChannel,
      workspaceId,
      workerId,
    });
    return { skipped: true, reason: "mode_off" };
  }

  const previousState = readBootstrapState();
  try {
    const manifest = await withTimeout(
      getWorkerGlobalSkillsManifest(),
      skillsBootstrapTimeoutMs,
      "skills_manifest_fetch",
    );
    const lockfile = await withTimeout(
      materializeGlobalSkillsFromManifest(manifest),
      skillsBootstrapTimeoutMs,
      "skills_materialization",
    );
    const nextState = {
      source: "db_manifest",
      status: "ready",
      required: skillsBootstrapRequired,
      appliedAt: Date.now(),
      releaseChannel: globalSkillsReleaseChannel,
      workspaceId,
      workerId,
      lastError: null,
      lastKnownGood: {
        manifestVersion: lockfile.manifestVersion,
        generatedAt: lockfile.generatedAt,
        skillsCount: lockfile.skillsCount,
      },
      lockfile,
    };
    writeBootstrapState(nextState);
    log(
      `Global skills ready count=${lockfile.skillsCount} version=${lockfile.manifestVersion} dir=${openClawSkillsDir}`,
    );
    return { skipped: false, lockfile };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeBootstrapState({
      source: "db_manifest",
      status: "failed",
      required: skillsBootstrapRequired,
      failedAt: Date.now(),
      releaseChannel: globalSkillsReleaseChannel,
      workspaceId,
      workerId,
      skillsDir: openClawSkillsDir,
      lastError: message,
      lastKnownGood: previousState?.lastKnownGood ?? null,
    });
    throw error;
  }
}

async function main() {
  log(
    `START workerId=${workerId} mode=${skillsBootstrapMode} required=${skillsBootstrapRequired} dir=${openClawSkillsDir}`,
  );
  try {
    await restoreSnapshotIfNeeded();
  } catch (error) {
    warn(`restore failed before bootstrap: ${error instanceof Error ? error.message : String(error)}`);
  }
  ensureWorkspaceMemoryFiles();

  try {
    await bootstrapGlobalSkillsIfConfigured();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (skillsBootstrapRequired) {
      throw new Error(`skills_bootstrap_required_failed: ${message}`);
    }
    warn(`Skills bootstrap fallback: ${message}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[bootstrap] FATAL: ${message}`);
  process.exit(1);
});
