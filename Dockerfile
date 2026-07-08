# Orkestral — imagem headless para VPS (Docker/Compose), Node PURO.
#
# bin/orkestral detecta que o Electron não está instalado e roda out/main/cli.js
# direto no Node — sem Chromium, sem Xvfb, sem libs X. O gateway web (porta 6750)
# serve a UI pro navegador; o token de acesso sai no log do boot.
#
# Multi-stage:
#   - build  (node:22-bookworm)       → deps completas (devDeps p/ electron-vite)
#                                        + electron-vite build → out/
#   - runtime(node:22-bookworm-slim)  → npm install --omit=dev (SEM electron;
#                                        nativos no ABI do Node) + out/ + bin/
#
# O postinstall (scripts/postinstall.mjs) só rebuilda pro Electron quando
# electron-builder existe — no runtime (--omit=dev) ele não existe, então os
# nativos (better-sqlite3, node-pty…) ficam compilados pro Node. É isso que
# permite o `node bin/orkestral` puro.

# ── Stage 1: build ──────────────────────────────────────────────
FROM node:22-bookworm AS build
WORKDIR /app

# Toolchain nativo pros addons (better-sqlite3, node-pty, node-llama-cpp, smart-whisper).
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential python3 && \
    rm -rf /var/lib/apt/lists/*

# `npm install` (não `npm ci`) de propósito: o package-lock é gerado no macOS e
# não lista os optional deps SÓ-Linux (ex.: @emnapi/*) — `npm ci` estrito aborta.
COPY package.json package-lock.json ./
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
RUN npm install --no-audit --no-fund --loglevel=error

# Código + build. `electron-vite build` direto (NÃO `npm run build`, que roda
# setup:models e baixaria 640MB de modelos — eles baixam sob demanda em runtime).
COPY . .
RUN npx electron-vite build

# ── Stage 2: runtime ────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Orkestral" \
      org.opencontainers.image.description="Orkestral headless daemon (Node puro) para VPS" \
      org.opencontainers.image.source="https://github.com/Orkestral-AI/orkestral" \
      org.opencontainers.image.url="https://orkestral.pro"

# ca-certificates: o -slim vem sem e todo HTTPS de saída morreria no TLS.
# git: agentes clonam/commitam em workspaces. build-essential/python3: addons
# nativos sem prebuild pra esta plataforma (ex.: node-pty) compilam no install.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates git build-essential python3 && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --home-dir /home/orkestral --shell /bin/bash orkestral

WORKDIR /app

# Deps de produção compiladas pro ABI do NODE (sem electron, que é devDep).
COPY package.json package-lock.json ./
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error && \
    npm cache clean --force

# App buildado + bin.
COPY --from=build --chown=orkestral:orkestral /app/out ./out
COPY --chown=orkestral:orkestral bin ./bin

ENV NODE_ENV=production
ENV HOME=/home/orkestral

# Node puro: TODO o estado (SQLite, secret.key, auth de canal, modelos baixados)
# vive em ~/.orkestral — não existe mais o userData do Electron (~/.config/Orkestral).
RUN install -d -m 0700 -o orkestral -g orkestral /home/orkestral/.orkestral

USER orkestral

# Gateway web (UI no navegador). O token de acesso sai no log de boot:
#   docker compose logs orkestral | grep "UI web"
EXPOSE 6750

# Sem HEALTHCHECK no Dockerfile de propósito: `orkestral status` sobe os serviços
# (bootstrap do DB) a cada checagem — fica no docker-compose.yml com intervalo largo.

ENTRYPOINT ["node", "bin/orkestral"]
CMD ["serve", "--no-tui", "--host", "0.0.0.0"]
