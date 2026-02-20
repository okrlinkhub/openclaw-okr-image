#!/bin/bash
set -euo pipefail

mkdir -p /data /data/openclaw

# Pulisce lock/runtime temporanei a ogni boot per evitare stalli
# non deterministici dopo restart o comandi concorrenti.
rm -rf /tmp/openclaw /tmp/openclaw-* || true

# Persistenza esplicita stato/config OpenClaw sul volume Fly.
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/data/openclaw/state}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/data/openclaw/config.json}"
mkdir -p "${OPENCLAW_STATE_DIR}"

gateway_port="${OPENCLAW_GATEWAY_PORT:-3000}"
gateway_bind="${OPENCLAW_GATEWAY_BIND:-lan}"
gateway_dev_mode="${OPENCLAW_GATEWAY_DEV_MODE:-false}"
config_dir="$(dirname "${OPENCLAW_CONFIG_PATH}")"
mkdir -p "${config_dir}"

# Workaround per versioni CLI che richiedono config esplicita
# anche quando viene passato --allow-unconfigured.
if [ ! -f "${OPENCLAW_CONFIG_PATH}" ]; then
  cat > "${OPENCLAW_CONFIG_PATH}" <<EOF
{
  "gateway": {
    "mode": "local",
    "bind": "${gateway_bind}",
    "port": ${gateway_port}
  }
}
EOF
fi

gateway_args=(
  gateway
  run
  --allow-unconfigured
  --bind "${gateway_bind}"
  --port "${gateway_port}"
)

if [ "${gateway_dev_mode}" = "true" ]; then
  gateway_args+=(--dev)
fi

if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  gateway_args+=(--token "${OPENCLAW_GATEWAY_TOKEN}")
fi

startup_timeout_sec="${OPENCLAW_STARTUP_TIMEOUT_SEC:-240}"
probe_interval_sec="${OPENCLAW_PROBE_INTERVAL_SEC:-3}"

run_gateway() {
  if [ -f /app/openclaw.mjs ]; then
    node /app/openclaw.mjs "${gateway_args[@]}" &
  elif command -v openclaw >/dev/null 2>&1; then
    openclaw "${gateway_args[@]}" &
  else
    echo '{"error":"OpenClaw CLI not found (/app/openclaw.mjs or openclaw binary)"}' >&2
    exit 1
  fi
  gateway_pid=$!
}

probe_gateway_port() {
  node -e "const net=require('net');const port=Number(process.argv[1]);const s=net.connect(port,'127.0.0.1');let done=false;const end=(code)=>{if(done)return;done=true;try{s.destroy();}catch{};process.exit(code);};s.on('connect',()=>end(0));s.on('error',()=>end(1));setTimeout(()=>end(1),1000);" "${gateway_port}"
}

forward_signal() {
  local sig="$1"
  if [ -n "${gateway_pid:-}" ] && kill -0 "${gateway_pid}" 2>/dev/null; then
    kill "-${sig}" "${gateway_pid}" 2>/dev/null || true
  fi
}

trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT

run_gateway
echo "[entrypoint] gateway pid=${gateway_pid}, readiness timeout=${startup_timeout_sec}s"

start_epoch="$(date +%s)"
while true; do
  if ! kill -0 "${gateway_pid}" 2>/dev/null; then
    echo "[entrypoint] gateway exited before readiness" >&2
    wait "${gateway_pid}" || true
    exit 1
  fi

  if probe_gateway_port >/dev/null 2>&1; then
    echo "[entrypoint] gateway is reachable on 127.0.0.1:${gateway_port}"
    break
  fi

  now_epoch="$(date +%s)"
  elapsed="$((now_epoch - start_epoch))"
  if [ "${elapsed}" -ge "${startup_timeout_sec}" ]; then
    echo "[entrypoint] readiness timeout after ${elapsed}s; stopping gateway" >&2
    kill -TERM "${gateway_pid}" 2>/dev/null || true
    sleep 2
    kill -KILL "${gateway_pid}" 2>/dev/null || true
    wait "${gateway_pid}" || true
    exit 1
  fi

  sleep "${probe_interval_sec}"
done

wait "${gateway_pid}"