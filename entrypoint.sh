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

ALLOWED_SKILLS_JSON_VALUE="${ALLOWED_SKILLS_JSON:-[\"linkhub-bridge\"]}"

mkdir -p /data

# Se non esiste il character file, crealo in modo idempotente.
if [ ! -f "/data/character.json" ]; then
  cat > /data/character.json <<EOF
{
  "name": "${AGENT_NAME:-Coach}",
  "clients": ["telegram", "discord"],
  "modelProvider": "openai",
  "skills": ${ALLOWED_SKILLS_JSON_VALUE},
  "settings": {
    "secrets": {
      "OPENAI_API_KEY": "${OPENAI_API_KEY}"
    }
  },
  "bio": [
    "Sono un coach OKR dedicato per ${USER_NAME}",
    "Aiuto a raggiungere gli obiettivi con metodo LinkHub"
  ]
}
EOF
fi

# Avvia OpenClaw con character persistito.
cd /app && exec openclaw run --character /data/character.json