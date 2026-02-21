FROM ghcr.io/openclaw/openclaw:latest@sha256:ace6f32961c4d574cb189d0007ec778408a9c02502f38af9ded6c864bae0f454

USER root

WORKDIR /app

# Assicura runtime Node + curl per health check runtime.
# Supporta sia immagini Alpine che Debian/Ubuntu.
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache nodejs curl; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends nodejs curl && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "Unsupported base image: cannot install nodejs"; \
      exit 1; \
    fi

# Verifica hard-fail anti regressioni build.
RUN node --version

RUN mkdir -p /data /app/skills

COPY skills/ /app/skills/
# Rende eseguibili eventuali script skills senza legarsi a una skill specifica.
RUN find /app/skills -type f -path "*/scripts/*" -exec chmod +x {} +

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
    OPENCLAW_SETUP_COMMAND="node /app/openclaw.mjs --dev setup" \
    OPENCLAW_RUN_SETUP=false \
    OPENCLAW_SETUP_TIMEOUT_MS=120000 \
    OPENCLAW_GATEWAY_COMMAND="node /app/openclaw.mjs gateway" \
    OPENCLAW_GATEWAY_READY_TIMEOUT_MS=30000 \
    OPENCLAW_GATEWAY_READY_POLL_MS=500

ENTRYPOINT ["/entrypoint.sh"]