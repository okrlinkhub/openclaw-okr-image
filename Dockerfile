FROM ghcr.io/openclaw/openclaw:main-slim-amd64@sha256:165568320ac3bb76c9b8da76ba9367e0cc4e6c06e7473e3db30ed2de415f027a

USER root

WORKDIR /app

# Assicura runtime Node + tooling di diagnostica per health check/runtime debug.
# Supporta sia immagini Alpine che Debian/Ubuntu.
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache nodejs curl tar procps iproute2 lsof; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends nodejs curl tar procps iproute2 lsof && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "Unsupported base image: cannot install nodejs"; \
      exit 1; \
    fi

# Verifica hard-fail anti regressioni build.
RUN node --version

RUN mkdir -p /data /app/skills

# This image currently ships without repo-local bundled skills.
# Keep the directory present so runtime logic can still mount or hydrate skills.

COPY worker.mjs /app/worker.mjs
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV OPENCLAW_GATEWAY_HOST=127.0.0.1 \
    OPENCLAW_GATEWAY_PORT=18789 \
    OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789 \
    OPENCLAW_STATE_DIR=/data/.clawdbot \
    OPENCLAW_WORKSPACE_DIR=/data/workspace \
    OPENCLAW_CONFIG_PATH=/data/.clawdbot/openclaw.json \
    OPENCLAW_REQUIRE_DATA_MOUNT=true \
    OPENCLAW_RUN_SETUP=false \
    OPENCLAW_SETUP_TIMEOUT_MS=120000 \
    OPENCLAW_GATEWAY_COMMAND="node /app/openclaw.mjs gateway" \
    OPENCLAW_GATEWAY_READY_TIMEOUT_MS=60000 \
    OPENCLAW_GATEWAY_READY_POLL_MS=500 \
    OPENCLAW_GATEWAY_READY_REQUIRED=true

ENTRYPOINT ["/entrypoint.sh"]