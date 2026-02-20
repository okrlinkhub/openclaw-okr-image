#!/bin/bash
set -euo pipefail

echo "[entrypoint] OpenClaw worker bootstrap starting..."

if [ -z "${CONVEX_URL:-}" ]; then
  echo "[entrypoint] FATAL: CONVEX_URL not set" >&2
  exit 1
fi

if [ ! -f "/app/worker.js" ]; then
  echo "[entrypoint] FATAL: /app/worker.js not found" >&2
  exit 1
fi

if [ ! -f "/app/openclaw.mjs" ]; then
  echo "[entrypoint] FATAL: /app/openclaw.mjs not found" >&2
  exit 1
fi

export WORKER_ID="${WORKER_ID:-$(cat /proc/sys/kernel/random/uuid)}"
echo "[entrypoint] Worker ID: ${WORKER_ID}"

export OPENCLAW_GATEWAY_HOST="${OPENCLAW_GATEWAY_HOST:-127.0.0.1}"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
export OPENCLAW_GATEWAY_URL="${OPENCLAW_GATEWAY_URL:-http://${OPENCLAW_GATEWAY_HOST}:${OPENCLAW_GATEWAY_PORT}}"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.clawdbot}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/data/.clawdbot/openclaw.json}"
export OPENCLAW_REQUIRE_DATA_MOUNT="${OPENCLAW_REQUIRE_DATA_MOUNT:-true}"
export OPENCLAW_SETUP_COMMAND="${OPENCLAW_SETUP_COMMAND:-node /app/openclaw.mjs --dev setup}"
export OPENCLAW_RUN_SETUP="${OPENCLAW_RUN_SETUP:-false}"
export OPENCLAW_SETUP_TIMEOUT_MS="${OPENCLAW_SETUP_TIMEOUT_MS:-120000}"
export OPENCLAW_GATEWAY_COMMAND="${OPENCLAW_GATEWAY_COMMAND:-node /app/openclaw.mjs gateway --allow-unconfigured --port ${OPENCLAW_GATEWAY_PORT}}"
export OPENCLAW_GATEWAY_READY_TIMEOUT_MS="${OPENCLAW_GATEWAY_READY_TIMEOUT_MS:-45000}"
export OPENCLAW_GATEWAY_READY_POLL_MS="${OPENCLAW_GATEWAY_READY_POLL_MS:-500}"
export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"

gateway_pid=""
worker_pid=""

cleanup() {
  local exit_code="${1:-0}"

  if [ -n "${worker_pid}" ] && kill -0 "${worker_pid}" >/dev/null 2>&1; then
    kill "${worker_pid}" >/dev/null 2>&1 || true
    wait "${worker_pid}" 2>/dev/null || true
  fi

  if [ -n "${gateway_pid}" ] && kill -0 "${gateway_pid}" >/dev/null 2>&1; then
    echo "[entrypoint] Stopping OpenClaw gateway pid=${gateway_pid}"
    kill "${gateway_pid}" >/dev/null 2>&1 || true
    wait "${gateway_pid}" 2>/dev/null || true
  fi

  exit "${exit_code}"
}

trap 'cleanup 143' SIGINT SIGTERM

if [ "${OPENCLAW_REQUIRE_DATA_MOUNT}" = "true" ]; then
  if ! awk '$2=="/data"{found=1} END{exit(found?0:1)}' /proc/mounts; then
    echo "[entrypoint] FATAL: /data is not a mounted Fly volume. Configure [[mounts]] and create volume first." >&2
    exit 1
  fi
fi

mkdir -p "${OPENCLAW_STATE_DIR}" "${OPENCLAW_WORKSPACE_DIR}" "$(dirname "${OPENCLAW_CONFIG_PATH}")"
echo "[entrypoint] OpenClaw state dir: ${OPENCLAW_STATE_DIR}"
echo "[entrypoint] OpenClaw workspace dir: ${OPENCLAW_WORKSPACE_DIR}"
echo "[entrypoint] OpenClaw config path: ${OPENCLAW_CONFIG_PATH}"

mkdir -p \
  "${OPENCLAW_STATE_DIR}/agents/main/sessions" \
  "${OPENCLAW_STATE_DIR}/agents/main/agent" \
  "${OPENCLAW_STATE_DIR}/cron/runs" \
  "${OPENCLAW_STATE_DIR}/devices" \
  "${OPENCLAW_STATE_DIR}/identity" \
  "${OPENCLAW_STATE_DIR}/credentials" \
  "${OPENCLAW_STATE_DIR}/media/inbound"

if [ ! -f "${OPENCLAW_STATE_DIR}/agents/main/sessions/sessions.json" ]; then
  echo "{}" > "${OPENCLAW_STATE_DIR}/agents/main/sessions/sessions.json"
fi
if [ ! -f "${OPENCLAW_STATE_DIR}/cron/jobs.json" ]; then
  cat > "${OPENCLAW_STATE_DIR}/cron/jobs.json" <<'JSON'
{"version":1,"jobs":[]}
JSON
fi
if [ ! -f "${OPENCLAW_STATE_DIR}/devices/paired.json" ]; then
  echo "{}" > "${OPENCLAW_STATE_DIR}/devices/paired.json"
fi
if [ ! -f "${OPENCLAW_STATE_DIR}/devices/pending.json" ]; then
  echo "{}" > "${OPENCLAW_STATE_DIR}/devices/pending.json"
fi
if [ ! -f "${OPENCLAW_STATE_DIR}/identity/device-auth.json" ]; then
  cat > "${OPENCLAW_STATE_DIR}/identity/device-auth.json" <<'JSON'
{"version":1,"tokens":{}}
JSON
fi
if [ ! -f "${OPENCLAW_STATE_DIR}/agents/main/agent/auth-profiles.json" ]; then
  cat > "${OPENCLAW_STATE_DIR}/agents/main/agent/auth-profiles.json" <<'JSON'
{"version":1,"profiles":{},"lastGood":{},"usageStats":{}}
JSON
fi
if [ ! -f "${OPENCLAW_CONFIG_PATH}" ]; then
  if [ -z "${OPENCLAW_GATEWAY_TOKEN}" ]; then
    OPENCLAW_GATEWAY_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')"
    export OPENCLAW_GATEWAY_TOKEN
  fi
  cat > "${OPENCLAW_CONFIG_PATH}" <<JSON
{
  "agents": {
    "defaults": {
      "workspace": "${OPENCLAW_WORKSPACE_DIR}"
    }
  },
  "gateway": {
    "port": ${OPENCLAW_GATEWAY_PORT},
    "mode": "local",
    "bind": "loopback",
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    },
    "trustedProxies": ["127.0.0.1"],
    "tailscale": {
      "mode": "off",
      "resetOnExit": false
    }
  }
}
JSON
  echo "[entrypoint] Seeded initial OpenClaw config"
fi

if [ "${OPENCLAW_RUN_SETUP}" = "true" ]; then
  setup_timeout_s="$(( (OPENCLAW_SETUP_TIMEOUT_MS + 999) / 1000 ))"
  echo "[entrypoint] Running OpenClaw setup: ${OPENCLAW_SETUP_COMMAND} (timeout ${OPENCLAW_SETUP_TIMEOUT_MS} ms)"
  if ! timeout "${setup_timeout_s}" bash -lc "${OPENCLAW_SETUP_COMMAND}"; then
    echo "[entrypoint] FATAL: OpenClaw setup failed or timed out" >&2
    cleanup 1
  fi
else
  echo "[entrypoint] OPENCLAW_RUN_SETUP=false, skipping interactive setup"
fi

echo "[entrypoint] Starting OpenClaw gateway: ${OPENCLAW_GATEWAY_COMMAND}"
bash -lc "${OPENCLAW_GATEWAY_COMMAND}" &
gateway_pid="$!"
echo "[entrypoint] Gateway PID: ${gateway_pid}"

started_at_ms="$(date +%s%3N)"
ready_deadline_ms="$((started_at_ms + OPENCLAW_GATEWAY_READY_TIMEOUT_MS))"

while true; do
  if ! kill -0 "${gateway_pid}" >/dev/null 2>&1; then
    echo "[entrypoint] FATAL: OpenClaw gateway exited before readiness" >&2
    wait "${gateway_pid}" || true
    cleanup 1
  fi

  # Gateway readiness is a local TCP probe; some gateway routes may not return HTTP 200 on "/".
  if bash -lc "exec 3<>/dev/tcp/${OPENCLAW_GATEWAY_HOST}/${OPENCLAW_GATEWAY_PORT}" >/dev/null 2>&1; then
    echo "[entrypoint] Gateway port ready at ${OPENCLAW_GATEWAY_HOST}:${OPENCLAW_GATEWAY_PORT}"
    break
  fi

  now_ms="$(date +%s%3N)"
  if [ "${now_ms}" -ge "${ready_deadline_ms}" ]; then
    echo "[entrypoint] FATAL: gateway readiness timeout (${OPENCLAW_GATEWAY_READY_TIMEOUT_MS} ms)" >&2
    cleanup 1
  fi

  sleep "$(awk "BEGIN { print ${OPENCLAW_GATEWAY_READY_POLL_MS} / 1000 }")"
done

echo "[entrypoint] Starting worker process"
node /app/worker.js &
worker_pid="$!"
set +e
wait "${worker_pid}"
worker_exit="$?"
set -e
echo "[entrypoint] Worker exited with code ${worker_exit}"
cleanup "${worker_exit}"