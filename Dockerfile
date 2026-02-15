FROM ghcr.io/openclaw/openclaw:latest

USER root

WORKDIR /app

# Assicura runtime Node per gli script skill.
# Supporta sia immagini Alpine che Debian/Ubuntu.
RUN if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache nodejs npm; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && apt-get install -y nodejs npm && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "Unsupported base image: cannot install nodejs"; \
      exit 1; \
    fi

# Verifica hard-fail anti regressioni build.
RUN node --version && npm --version

RUN mkdir -p /data /app/skills

COPY skills/ /app/skills/
RUN chmod +x /app/skills/linkhub-bridge/scripts/*.js

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]