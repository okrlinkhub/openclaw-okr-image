FROM ghcr.io/openclaw/openclaw:latest@sha256:ace6f32961c4d574cb189d0007ec778408a9c02502f38af9ded6c864bae0f454

USER root

WORKDIR /app

# Assicura runtime Node per gli script skill.
# Supporta sia immagini Alpine che Debian/Ubuntu.
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache nodejs; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*; \
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

COPY worker.js /app/worker.js
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]