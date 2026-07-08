#!/usr/bin/env bash
# Orkestral — instalador bare-metal para Ubuntu/Debian (VPS headless, Node PURO).
#
# Sem Electron em runtime: builda com devDeps, faz prune e recompila os addons
# nativos pro ABI do Node — o serviço roda `node bin/orkestral` direto (nada de
# xvfb/libs X). O gateway web serve a UI na porta 6750 (token no log do boot).
#
# Idempotente: pode rodar de novo com segurança (não sobrescreve a chave nem
# reinicia o serviço). Instala Node 22, coloca o repo em /opt/orkestral, builda,
# cria o wrapper /usr/local/bin/orkestral, o EnvironmentFile /etc/orkestral/env
# e a unit systemd. NÃO habilita/inicia o serviço automaticamente — pareie um
# canal com `orkestral init` antes.
#
# Uso (a partir de um checkout do repo, como root ou com sudo):
#   sudo ./install.sh
set -euo pipefail

REPO_DIR=/opt/orkestral
ENV_DIR=/etc/orkestral
ENV_FILE="$ENV_DIR/env"
WRAPPER=/usr/local/bin/orkestral
SERVICE=/etc/systemd/system/orkestral.service
NODE_MAJOR=22
REPO_URL="https://github.com/Orkestral-AI/orkestral.git"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mx\033[0m %s\n' "$*" >&2; exit 1; }

# ── root/sudo ────────────────────────────────────────────────────
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  die "rode como root ou via sudo: sudo ./install.sh"
fi

command -v apt-get >/dev/null 2>&1 || die "este instalador é para Ubuntu/Debian (apt-get não encontrado)"

# Onde estamos rodando (checkout local do repo, se houver).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Node 22 (nodesource) se ausente/desatualizado ────────────────
install_node() {
  local current=""
  if command -v node >/dev/null 2>&1; then
    current="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  fi
  if [[ "${current:-0}" -ge "$NODE_MAJOR" ]]; then
    log "Node $(node -v) já presente"
    return
  fi
  log "Instalando Node ${NODE_MAJOR} (nodesource)"
  apt-get install -y --no-install-recommends ca-certificates curl gnupg
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
}

# ── libs de sistema (build de nativos + git) — SEM xvfb/X ────────
log "Atualizando índice de pacotes"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

log "Instalando dependências de sistema (git, build tools)"
apt-get install -y --no-install-recommends \
  git ca-certificates build-essential python3 openssl

install_node

# ── repo em /opt/orkestral ───────────────────────────────────────
if [[ -f "$SCRIPT_DIR/package.json" ]] && grep -q '"name": "orkestral"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
  if [[ "$SCRIPT_DIR" != "$REPO_DIR" ]]; then
    log "Sincronizando checkout local -> $REPO_DIR"
    mkdir -p "$REPO_DIR"
    # Copia o checkout atual (exclui artefatos volumosos; serão gerados no build).
    tar -C "$SCRIPT_DIR" \
      --exclude=node_modules --exclude=out --exclude=dist --exclude=.git \
      -cf - . | tar -C "$REPO_DIR" -xf -
  fi
elif [[ -d "$REPO_DIR/.git" ]]; then
  log "Atualizando repo em $REPO_DIR (git pull)"
  git -C "$REPO_DIR" pull --ff-only || warn "git pull falhou; seguindo com o checkout atual"
else
  log "Clonando repo em $REPO_DIR"
  git clone --depth 1 "$REPO_URL" "$REPO_DIR"
fi

# ── deps + build + prune (runtime Node puro) ─────────────────────
log "Instalando dependências (npm install — build precisa das devDeps)"
( cd "$REPO_DIR" && npm install --no-audit --no-fund --loglevel=error )

# electron-vite build direto (NÃO `npm run build`, que baixaria modelos de
# embedding via setup:models — eles baixam sob demanda em runtime).
log "Buildando o app (electron-vite build)"
( cd "$REPO_DIR" && npx electron-vite build )

# Remove devDeps (electron incluso) e recompila os addons nativos pro ABI do
# NODE — o postinstall dev tinha rebuildado better-sqlite3/node-pty pro Electron.
log "Removendo devDeps e recompilando nativos pro Node"
( cd "$REPO_DIR" && npm prune --omit=dev --no-audit --no-fund --loglevel=error )
( cd "$REPO_DIR" && npm rebuild better-sqlite3 node-pty --loglevel=error )

# ── wrapper /usr/local/bin/orkestral ─────────────────────────────
log "Instalando wrapper $WRAPPER"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
# CLI do Orkestral em Node puro (sem Electron/Xvfb).
exec node "$REPO_DIR/bin/orkestral" "\$@"
EOF
chmod 755 "$WRAPPER"

# ── /etc/orkestral/env (chmod 600, chave gerada se ausente) ──────
mkdir -p "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Gerando $ENV_FILE com ORKESTRAL_SECRET_KEY"
  umask 077
  cat > "$ENV_FILE" <<EOF
# Segredos de runtime do Orkestral (lido pelo systemd via EnvironmentFile).
# Chave de 32 bytes base64 pra cifrar segredos sem keychain do SO.
ORKESTRAL_SECRET_KEY=$(openssl rand -base64 32)
# Auth do agente (descomente a do seu provedor, ou configure pela página Provedores):
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# GEMINI_API_KEY=
EOF
  chmod 600 "$ENV_FILE"
else
  log "$ENV_FILE já existe — mantendo (idempotente)"
fi

# ── systemd unit ─────────────────────────────────────────────────
log "Instalando unit systemd $SERVICE"
cat > "$SERVICE" <<EOF
[Unit]
Description=Orkestral daemon
After=network-online.target
Wants=network-online.target

# Sem User= => roda como root; estado em /root/.orkestral (Node puro).
# O pareamento ('orkestral init') tem que rodar com o MESMO usuário (sudo),
# senão a auth do canal cai em outro home e o serviço não a enxerga.
#
# --host 0.0.0.0 expõe a UI web na porta 6750 — o acesso exige o token da URL
# (sai no journal). Pra restringir ao localhost (reverse proxy na frente),
# troque para --host 127.0.0.1.
[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$WRAPPER serve --no-tui --host 0.0.0.0 --port 6750
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

# ── próximos passos (sem habilitar/iniciar automaticamente) ──────
cat <<EOF

$(log "Instalação concluída.")

Próximos passos:
  1) Pareie um canal (ex.: WhatsApp — lê o QR no terminal):
       orkestral init
  2) Habilite e inicie o daemon:
       sudo systemctl enable --now orkestral
  3) Pegue a URL da UI web (com o token de acesso):
       journalctl -u orkestral | grep "UI web" | tail -1
  4) Acompanhe os logs:
       journalctl -u orkestral -f

Auth do agente: edite $ENV_FILE (chmod 600) e descomente a key do seu provedor,
ou configure pela página Provedores. Depois: sudo systemctl restart orkestral
EOF
