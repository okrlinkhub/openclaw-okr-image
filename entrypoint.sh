#!/bin/bash
set -euo pipefail

echo "[entrypoint] Convex worker starting..."

if [ -z "${CONVEX_URL:-}" ]; then
  echo "[entrypoint] FATAL: CONVEX_URL not set" >&2
  exit 1
fi

if [ ! -f "/app/worker.js" ]; then
  echo "[entrypoint] FATAL: /app/worker.js not found" >&2
  exit 1
fi

export WORKER_ID="${WORKER_ID:-$(cat /proc/sys/kernel/random/uuid)}"
echo "[entrypoint] Worker ID: ${WORKER_ID}"

exec node /app/worker.js