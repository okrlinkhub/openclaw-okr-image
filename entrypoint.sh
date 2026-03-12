#!/bin/bash
set -euo pipefail

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  echo "[entrypoint] $(timestamp) $*"
}

warn() {
  echo "[entrypoint] $(timestamp) WARN: $*" >&2
}

fatal() {
  echo "[entrypoint] $(timestamp) FATAL: $*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_gateway_command() {
  local legacy_node="/app/openclaw.mjs gateway"
  local legacy_wrapper="node /app/openclaw.mjs gateway"
  local configured="${OPENCLAW_GATEWAY_COMMAND:-}"

  if [ -z "${configured}" ] || [ "${configured}" = "${legacy_node}" ] || [ "${configured}" = "${legacy_wrapper}" ]; then
    printf 'node /app/openclaw.mjs gateway --port %s' "${OPENCLAW_GATEWAY_PORT}"
    if is_truthy "${OPENCLAW_GATEWAY_VERBOSE:-false}"; then
      printf ' --verbose'
    fi
    return
  fi

  printf '%s' "${configured}"
}

env_state() {
  local key="$1"
  if [ -n "${!key:-}" ]; then
    printf "SET"
  else
    printf "MISSING"
  fi
}

print_env_presence() {
  log "Environment presence summary:"
  local keys=(
    CONVEX_URL
    MOONSHOT_API_KEY
    OPENAI_API_KEY
    OPENCLAW_AGENT_MODEL
    OPENCLAW_GATEWAY_COMMAND
    OPENCLAW_GATEWAY_HOST
    OPENCLAW_GATEWAY_PORT
    OPENCLAW_GATEWAY_URL
    OPENCLAW_GATEWAY_VERBOSE
    OPENCLAW_GATEWAY_STREAM_LOGS
    OPENCLAW_SERVICE_ID
    OPENCLAW_SERVICE_KEY
    WORKER_ID
    WORKER_IDLE_TIMEOUT_MS
  )
  local key
  for key in "${keys[@]}"; do
    log "  - ${key}=$(env_state "${key}")"
  done
}

print_runtime_expectations() {
  if [ -z "${CONVEX_URL:-}" ]; then
    fatal "CONVEX_URL not set"
  fi

  if [ -n "${OPENCLAW_AGENT_MODEL:-}" ]; then
    case "${OPENCLAW_AGENT_MODEL}" in
      moonshot/*|kimi/*)
        if [ -z "${MOONSHOT_API_KEY:-}" ]; then
          warn "OPENCLAW_AGENT_MODEL=${OPENCLAW_AGENT_MODEL} suggests Moonshot, but MOONSHOT_API_KEY is missing"
        fi
        ;;
      openai/*|gpt-*)
        if [ -z "${OPENAI_API_KEY:-}" ]; then
          warn "OPENCLAW_AGENT_MODEL=${OPENCLAW_AGENT_MODEL} suggests OpenAI, but OPENAI_API_KEY is missing"
        fi
        ;;
    esac
  fi

  if [ -n "${OPENCLAW_SERVICE_ID:-}" ] && [ -z "${OPENCLAW_SERVICE_KEY:-}" ]; then
    warn "OPENCLAW_SERVICE_ID is set but OPENCLAW_SERVICE_KEY is missing"
  fi
}

dump_proc_net_tables() {
  if [ -r /proc/net/tcp ] || [ -r /proc/net/tcp6 ]; then
    log "Kernel TCP tables snapshot:"
    sed 's/^/[entrypoint] tcp  /' /proc/net/tcp 2>/dev/null || true
    sed 's/^/[entrypoint] tcp6 /' /proc/net/tcp6 2>/dev/null || true
  fi
}

dump_gateway_diagnostics() {
  local reason="$1"
  log "Gateway diagnostics begin (reason=${reason})"
  print_env_presence

  if [ -f "${OPENCLAW_CONFIG_PATH}" ]; then
    log "OpenClaw config snapshot (${OPENCLAW_CONFIG_PATH}):"
    sed 's/^/[entrypoint] cfg  /' "${OPENCLAW_CONFIG_PATH}" 2>/dev/null || true
  else
    warn "OpenClaw config file missing at ${OPENCLAW_CONFIG_PATH}"
  fi

  log "Process snapshot:"
  ps -ww -ef 2>/dev/null | sed 's/^/[entrypoint] ps   /' || true

  if [ -n "${gateway_pid}" ] && kill -0 "${gateway_pid}" >/dev/null 2>&1; then
    log "Gateway process status for pid=${gateway_pid}:"
    sed 's/^/[entrypoint] proc /' "/proc/${gateway_pid}/status" 2>/dev/null || true
    if [ -r "/proc/${gateway_pid}/cmdline" ]; then
      log "Gateway cmdline:"
      tr '\0' ' ' <"/proc/${gateway_pid}/cmdline" 2>/dev/null | sed 's/^/[entrypoint] cmd  /' || true
      echo
    fi
    if [ -r "/proc/${gateway_pid}/wchan" ]; then
      log "Gateway wait channel:"
      sed 's/^/[entrypoint] wchan /' "/proc/${gateway_pid}/wchan" 2>/dev/null || true
    fi
    if [ -r "/proc/${gateway_pid}/syscall" ]; then
      log "Gateway current syscall:"
      sed 's/^/[entrypoint] sys  /' "/proc/${gateway_pid}/syscall" 2>/dev/null || true
    fi
    if [ -d "/proc/${gateway_pid}/fd" ]; then
      log "Gateway file descriptors:"
      ls -l "/proc/${gateway_pid}/fd" 2>/dev/null | sed 's/^/[entrypoint] fd   /' || true
    fi
  else
    warn "Gateway pid is not running during diagnostics"
  fi

  if command_exists ss; then
    log "Listening sockets via ss:"
    ss -lntp 2>/dev/null | sed 's/^/[entrypoint] ss   /' || true
  elif command_exists netstat; then
    log "Listening sockets via netstat:"
    netstat -lntp 2>/dev/null | sed 's/^/[entrypoint] net  /' || true
  else
    dump_proc_net_tables
  fi

  if command_exists curl; then
    local probe_url="${OPENCLAW_GATEWAY_URL}${OPENCLAW_GATEWAY_PROBE_PATH}"
    log "Gateway probe attempt: ${probe_url}"
    curl -sS -m 3 -D - "${probe_url}" 2>&1 | sed 's/^/[entrypoint] curl /' || true
  fi

  if [ -f "${OPENCLAW_GATEWAY_LOG_PATH}" ]; then
    log "Gateway log tail (${OPENCLAW_GATEWAY_DIAGNOSTIC_TAIL_LINES} lines): ${OPENCLAW_GATEWAY_LOG_PATH}"
    tail -n "${OPENCLAW_GATEWAY_DIAGNOSTIC_TAIL_LINES}" "${OPENCLAW_GATEWAY_LOG_PATH}" 2>/dev/null | sed 's/^/[entrypoint] log  /' || true
  else
    warn "Gateway log file missing at ${OPENCLAW_GATEWAY_LOG_PATH}"
  fi

  log "Gateway diagnostics end"
}

log "OpenClaw worker bootstrap starting..."

print_runtime_expectations

if [ ! -f "/app/worker.mjs" ]; then
  fatal "/app/worker.mjs not found"
fi

if [ ! -f "/app/openclaw.mjs" ]; then
  fatal "/app/openclaw.mjs not found"
fi

export WORKER_ID="${WORKER_ID:-$(cat /proc/sys/kernel/random/uuid)}"
log "Worker ID: ${WORKER_ID}"

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
export OPENCLAW_GATEWAY_READY_TIMEOUT_MS="${OPENCLAW_GATEWAY_READY_TIMEOUT_MS:-60000}"
export OPENCLAW_GATEWAY_READY_POLL_MS="${OPENCLAW_GATEWAY_READY_POLL_MS:-500}"
export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
export OPENCLAW_GATEWAY_READY_REQUIRED="${OPENCLAW_GATEWAY_READY_REQUIRED:-true}"
export OPENCLAW_AGENT_MODEL="${OPENCLAW_AGENT_MODEL:-}"
export OPENCLAW_GATEWAY_VERBOSE="${OPENCLAW_GATEWAY_VERBOSE:-false}"
export OPENCLAW_GATEWAY_STREAM_LOGS="${OPENCLAW_GATEWAY_STREAM_LOGS:-false}"
export OPENCLAW_DIAGNOSTICS_DIR="${OPENCLAW_DIAGNOSTICS_DIR:-${OPENCLAW_STATE_DIR}/logs}"
export OPENCLAW_GATEWAY_LOG_PATH="${OPENCLAW_GATEWAY_LOG_PATH:-${OPENCLAW_DIAGNOSTICS_DIR}/gateway-startup.log}"
export OPENCLAW_GATEWAY_DIAGNOSTIC_TAIL_LINES="${OPENCLAW_GATEWAY_DIAGNOSTIC_TAIL_LINES:-200}"
export OPENCLAW_GATEWAY_PROBE_PATH="${OPENCLAW_GATEWAY_PROBE_PATH:-/health}"
export OPENCLAW_GATEWAY_COMMAND="$(resolve_gateway_command)"

gateway_pid=""
worker_pid=""
gateway_log_tee_pid=""
gateway_log_pipe=""

cleanup() {
  local exit_code="${1:-0}"

  if [ -n "${worker_pid}" ] && kill -0 "${worker_pid}" >/dev/null 2>&1; then
    kill "${worker_pid}" >/dev/null 2>&1 || true
    wait "${worker_pid}" 2>/dev/null || true
  fi

  if [ -n "${gateway_pid}" ] && kill -0 "${gateway_pid}" >/dev/null 2>&1; then
    log "Stopping OpenClaw gateway pid=${gateway_pid}"
    kill "${gateway_pid}" >/dev/null 2>&1 || true
    wait "${gateway_pid}" 2>/dev/null || true
  fi

  if [ -n "${gateway_log_tee_pid}" ] && kill -0 "${gateway_log_tee_pid}" >/dev/null 2>&1; then
    kill "${gateway_log_tee_pid}" >/dev/null 2>&1 || true
    wait "${gateway_log_tee_pid}" 2>/dev/null || true
  fi

  if [ -n "${gateway_log_pipe}" ] && [ -p "${gateway_log_pipe}" ]; then
    rm -f "${gateway_log_pipe}" >/dev/null 2>&1 || true
  fi

  exit "${exit_code}"
}

trap 'cleanup 143' SIGINT SIGTERM

if [ "${OPENCLAW_REQUIRE_DATA_MOUNT}" = "true" ]; then
  if ! awk '$2=="/data"{found=1} END{exit(found?0:1)}' /proc/mounts; then
    fatal "/data is not a mounted Fly volume. Configure [[mounts]] and create volume first."
  fi
fi

mkdir -p "${OPENCLAW_STATE_DIR}" "${OPENCLAW_WORKSPACE_DIR}" "$(dirname "${OPENCLAW_CONFIG_PATH}")" "${OPENCLAW_DIAGNOSTICS_DIR}"
log "OpenClaw state dir: ${OPENCLAW_STATE_DIR}"
log "OpenClaw workspace dir: ${OPENCLAW_WORKSPACE_DIR}"
log "OpenClaw config path: ${OPENCLAW_CONFIG_PATH}"
log "OpenClaw diagnostics dir: ${OPENCLAW_DIAGNOSTICS_DIR}"
print_env_presence

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
if [ -z "${OPENCLAW_GATEWAY_TOKEN}" ]; then
  OPENCLAW_GATEWAY_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')"
  export OPENCLAW_GATEWAY_TOKEN
fi

if [ ! -f "${OPENCLAW_CONFIG_PATH}" ]; then
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
    }
  }
}
JSON
  log "Seeded initial OpenClaw config"
fi

node -e "
  const fs = require('fs');
  const p = '${OPENCLAW_CONFIG_PATH}';
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  let changed = false;

  c.agents = c.agents || {};
  c.agents.defaults = c.agents.defaults || {};
  c.gateway = c.gateway || {};

  // Clean up invalid 'fallback' key (singular) from prior versions
  if (c.agents.defaults.model?.fallback) {
    delete c.agents.defaults.model.fallback;
    changed = true;
    console.log('[entrypoint] Removed invalid model.fallback key');
  }

  const wantModel = process.env.OPENCLAW_AGENT_MODEL || '';
  if (wantModel) {
    const haveModel = c.agents.defaults.model?.primary;
    const haveFallbacks = JSON.stringify(c.agents.defaults.model?.fallbacks || []);
    const wantFallbacks = (wantModel.startsWith('moonshot/') && process.env.OPENAI_API_KEY)
      ? ['openai/gpt-4o-mini'] : [];
    if (haveModel !== wantModel || haveFallbacks !== JSON.stringify(wantFallbacks)) {
      c.agents.defaults.model = { primary: wantModel };
      if (wantFallbacks.length > 0) c.agents.defaults.model.fallbacks = wantFallbacks;
      changed = true;
      console.log('[entrypoint] Updated agent model to ' + wantModel +
        (wantFallbacks.length ? ' (fallbacks: ' + wantFallbacks.join(', ') + ')' : ''));
    }
  }

  if (process.env.MOONSHOT_API_KEY) {
    c.models = c.models || {};
    c.models.mode = 'merge';
    c.models.providers = c.models.providers || {};
    const wantBase = 'https://api.moonshot.ai/v1';
    const cur = c.models.providers.moonshot;
    if (!cur || cur.baseUrl !== wantBase) {
      c.models.providers.moonshot = {
        baseUrl: wantBase,
        apiKey: '\${MOONSHOT_API_KEY}',
        api: 'openai-completions',
        models: [{
          id: 'kimi-k2.5',
          name: 'Kimi K2.5',
          contextWindow: 256000,
          maxTokens: 8192,
        }],
      };
      changed = true;
      console.log('[entrypoint] Configured moonshot provider (Moonshot endpoint)');
    }
  }

  const wantGatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT || '18789');
  if (c.gateway.mode !== 'local') {
    c.gateway.mode = 'local';
    changed = true;
    console.log('[entrypoint] Set gateway.mode=local');
  }
  if (c.gateway.bind !== 'loopback') {
    c.gateway.bind = 'loopback';
    changed = true;
    console.log('[entrypoint] Set gateway.bind=loopback');
  }
  if (c.gateway.port !== wantGatewayPort) {
    c.gateway.port = wantGatewayPort;
    changed = true;
    console.log('[entrypoint] Set gateway.port=' + wantGatewayPort);
  }

  const wantGatewayAuth = process.env.OPENCLAW_GATEWAY_TOKEN
    ? { mode: 'token', token: process.env.OPENCLAW_GATEWAY_TOKEN }
    : undefined;
  const haveGatewayAuth = JSON.stringify(c.gateway.auth || null);
  const needGatewayAuth = JSON.stringify(wantGatewayAuth || null);
  if (haveGatewayAuth !== needGatewayAuth) {
    if (wantGatewayAuth) c.gateway.auth = wantGatewayAuth;
    else delete c.gateway.auth;
    changed = true;
    console.log('[entrypoint] Normalized gateway auth configuration');
  }

  for (const legacyKey of ['http', 'trustedProxies', 'tailscale']) {
    if (legacyKey in c.gateway) {
      delete c.gateway[legacyKey];
      changed = true;
      console.log('[entrypoint] Removed unsupported gateway.' + legacyKey + ' config');
    }
  }

  if (changed) {
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
  }
"

if [ "${OPENCLAW_RUN_SETUP}" = "true" ]; then
  setup_timeout_s="$(( (OPENCLAW_SETUP_TIMEOUT_MS + 999) / 1000 ))"
  log "Running OpenClaw setup: ${OPENCLAW_SETUP_COMMAND} (timeout ${OPENCLAW_SETUP_TIMEOUT_MS} ms)"
  if ! timeout "${setup_timeout_s}" eval "${OPENCLAW_SETUP_COMMAND}"; then
    warn "OpenClaw setup failed or timed out"
    cleanup 1
  fi
else
  log "OPENCLAW_RUN_SETUP=false, skipping interactive setup"
fi

rm -f "${OPENCLAW_GATEWAY_LOG_PATH}"
touch "${OPENCLAW_GATEWAY_LOG_PATH}"
log "Starting OpenClaw gateway: ${OPENCLAW_GATEWAY_COMMAND}"
log "gateway node=$(which node 2>&1)"
if is_truthy "${OPENCLAW_GATEWAY_STREAM_LOGS}"; then
  gateway_log_pipe="${OPENCLAW_DIAGNOSTICS_DIR}/gateway-startup.pipe"
  rm -f "${gateway_log_pipe}"
  mkfifo "${gateway_log_pipe}"
  tee -a "${OPENCLAW_GATEWAY_LOG_PATH}" <"${gateway_log_pipe}" &
  gateway_log_tee_pid="$!"
  log "Gateway logs are streamed to stdout and saved to ${OPENCLAW_GATEWAY_LOG_PATH}"
  sh -lc "exec ${OPENCLAW_GATEWAY_COMMAND}" >"${gateway_log_pipe}" 2>&1 &
else
  log "Gateway logs are saved to ${OPENCLAW_GATEWAY_LOG_PATH} (stdout streaming disabled)"
  sh -lc "exec ${OPENCLAW_GATEWAY_COMMAND}" >>"${OPENCLAW_GATEWAY_LOG_PATH}" 2>&1 &
fi
gateway_pid="$!"
log "Gateway PID: ${gateway_pid}"

started_at_ms="$(date +%s%3N)"
ready_deadline_ms="$((started_at_ms + OPENCLAW_GATEWAY_READY_TIMEOUT_MS))"
gateway_ready="false"
poll_sleep="$(awk "BEGIN { print ${OPENCLAW_GATEWAY_READY_POLL_MS} / 1000 }")"

while true; do
  if ! kill -0 "${gateway_pid}" >/dev/null 2>&1; then
    warn "OpenClaw gateway exited before readiness"
    gateway_exit_code=0
    wait "${gateway_pid}" || gateway_exit_code="$?"
    warn "Gateway exit code before readiness: ${gateway_exit_code}"
    dump_gateway_diagnostics "gateway-exited-before-readiness"
    if [ "${OPENCLAW_GATEWAY_READY_REQUIRED}" = "true" ]; then
      cleanup 1
    fi
    break
  fi

  if (echo >/dev/tcp/${OPENCLAW_GATEWAY_HOST}/${OPENCLAW_GATEWAY_PORT}) 2>/dev/null; then
    log "Gateway port ready at ${OPENCLAW_GATEWAY_HOST}:${OPENCLAW_GATEWAY_PORT}"
    gateway_ready="true"
    break
  fi

  now_ms="$(date +%s%3N)"
  if [ "${now_ms}" -ge "${ready_deadline_ms}" ]; then
    warn "gateway readiness timeout (${OPENCLAW_GATEWAY_READY_TIMEOUT_MS} ms)"
    dump_gateway_diagnostics "gateway-readiness-timeout"
    if [ "${OPENCLAW_GATEWAY_READY_REQUIRED}" = "true" ]; then
      cleanup 1
    fi
    break
  fi

  sleep "${poll_sleep}"
done

if [ "${gateway_ready}" != "true" ]; then
  log "Proceeding without confirmed gateway readiness"
fi

log "node=$(which node) version=$(node --version 2>&1) PATH=${PATH}"
log "Starting worker process"
node /app/worker.mjs &
worker_pid="$!"
set +e
wait "${worker_pid}"
worker_exit="$?"
set -e
log "Worker exited with code ${worker_exit}"
cleanup "${worker_exit}"