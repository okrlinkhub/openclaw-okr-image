#!/bin/bash
set -euo pipefail

# Variabili minime richieste per la skill linkhub-bridge.
required_vars=(
  "AGENT_BRIDGE_URL"
  "OPENCLAW_SERVICE_ID"
  "OPENCLAW_SERVICE_KEY"
)

for var_name in "${required_vars[@]}"; do
  if [ -z "${!var_name:-}" ]; then
    echo "{\"error\":\"${var_name} not set\"}" >&2
    exit 1
  fi
done

mkdir -p /data /data/openclaw

# Persistenza esplicita stato/config OpenClaw sul volume Fly.
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-/data/openclaw/state}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-/data/openclaw/config.json}"
mkdir -p "${OPENCLAW_STATE_DIR}"

gateway_port="${OPENCLAW_GATEWAY_PORT:-3000}"
gateway_bind="${OPENCLAW_GATEWAY_BIND:-lan}"
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
  --dev
  --bind "${gateway_bind}"
  --port "${gateway_port}"
)

if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  gateway_args+=(--token "${OPENCLAW_GATEWAY_TOKEN}")
fi

if [ -f /app/openclaw.mjs ]; then
  exec node /app/openclaw.mjs "${gateway_args[@]}"
elif command -v openclaw >/dev/null 2>&1; then
  exec openclaw "${gateway_args[@]}"
else
  echo '{"error":"OpenClaw CLI not found (/app/openclaw.mjs or openclaw binary)"}' >&2
  exit 1
fi