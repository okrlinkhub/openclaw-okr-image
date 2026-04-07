FROM ghcr.io/openclaw/openclaw:2026.4.5-slim-amd64@sha256:9212352005b81866b5a365d41122f986b23746eba9b22b21b853bd7f6b646967

USER root

WORKDIR /app

# Assicura runtime Node, CA bundle e tooling di diagnostica per health check/runtime debug.
# Supporta sia immagini Alpine che Debian/Ubuntu.
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache ca-certificates nodejs curl tar procps iproute2 lsof; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates nodejs curl tar procps iproute2 lsof && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "Unsupported base image: cannot install nodejs"; \
      exit 1; \
    fi

# Verifica hard-fail anti regressioni build.
RUN node --version

RUN mkdir -p /data /app/skills

# Global skills are hydrated into /data at prestart from the agent-factory manifest.
# Keep the directory present so the gateway can scan workspace skills deterministically.

COPY bootstrap.mjs /app/bootstrap.mjs
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
    OPENCLAW_GATEWAY_READY_REQUIRED=true \
    SKILLS_BOOTSTRAP_MODE=db_manifest \
    SKILLS_BOOTSTRAP_REQUIRED=false \
    SKILLS_BOOTSTRAP_TIMEOUT_MS=15000 \
    SKILLS_RELEASE_CHANNEL=stable \
    OPENCLAW_SKILLS_DIR=/data/workspace/skills

ENTRYPOINT ["/entrypoint.sh"]