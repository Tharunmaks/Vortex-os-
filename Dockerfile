# ─────────────────────────────────────────────────────────────────────────────
#  Vortex OS — a secure cloud Linux desktop for the MNX Hive bees
#  Debian 12 (bookworm) userland + Vortex web desktop
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /opt/vortex
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY bin ./bin

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="Vortex OS" \
      org.opencontainers.image.description="Secure cloud Linux desktop for the MNX Hive bees"

# A real Linux toolbox for the bees.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash bash-completion ca-certificates coreutils curl dnsutils file findutils \
      git htop iputils-ping jq less locales man-db nano net-tools openssh-client \
      procps psmisc python3 python3-pip python3-venv rsync tini tree unzip vim-tiny wget zip \
 && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 --shell /bin/bash bee \
 && mkdir -p /var/lib/vortex && chown bee:bee /var/lib/vortex && chmod 700 /var/lib/vortex

COPY --from=build /opt/vortex /opt/vortex

# Nested interactive shells (e.g. typing `bash`) get the Hive Guard too.
RUN printf '%s\n' \
  '' \
  '# Vortex OS — Hive Guard for nested shells' \
  'if [ -n "$HIVE_ROLE" ] && [ -z "${__HIVE_GUARD_LOADED:-}" ] && [ -z "${__HIVE_IN_RC:-}" ]; then' \
  '  . /opt/vortex/server/shell/hive-rc.sh' \
  'fi' >> /etc/bash.bashrc

ENV NODE_ENV=production \
    LANG=en_US.UTF-8 \
    VORTEX_HOST=0.0.0.0 \
    VORTEX_PORT=8420 \
    VORTEX_DATA_DIR=/var/lib/vortex

WORKDIR /opt/vortex
USER bee
VOLUME ["/var/lib/vortex"]
EXPOSE 8420
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.VORTEX_PORT+'/api/hive').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
