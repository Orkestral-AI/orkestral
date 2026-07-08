# Deploy do Orkestral em VPS (self-hosted)

O Orkestral roda headless num servidor Linux. A CLI executa o app buildado sob o
Electron como runtime, então o servidor precisa de um display virtual (`xvfb`) e
das libs do Electron — tudo isso já vem tratado nas duas opções abaixo.

Duas formas:

- **Opção A — Docker/Compose** (recomendada; isola tudo numa imagem).
- **Opção B — install.sh** (bare-metal Ubuntu/Debian com systemd).

Antes de tudo, gere a chave de segredos (vale pras duas opções):

```bash
openssl rand -base64 32
```

Essa `ORKESTRAL_SECRET_KEY` cifra os segredos no servidor (que não tem keychain
do SO). **Mantenha estável**: se mudar, os segredos cifrados antes ficam ilegíveis.

---

## Opção A — Docker (3 comandos)

Pré-requisito: Docker + plugin Compose. No diretório do repo:

```bash
# 1) configure a chave
cp .env.example .env && ${EDITOR:-nano} .env   # preencha ORKESTRAL_SECRET_KEY

# 2) pareie um canal (interativo — o QR do WhatsApp aparece no terminal do servidor)
docker compose run --rm -it orkestral init

# 3) suba o daemon
docker compose up -d
```

Logs: `docker compose logs -f`

## Opção B — install.sh (2 comandos)

Num Ubuntu/Debian, a partir de um checkout do repo:

```bash
# 1) instala Node 22, xvfb, libs do Electron, builda, cria o serviço systemd
#    e gera /etc/orkestral/env com uma ORKESTRAL_SECRET_KEY nova (se não existir)
sudo ./install.sh

# 2) pareie um canal e depois habilite o serviço
#    use sudo: o daemon roda como root, então o pareamento precisa cair no
#    mesmo /root/.config/Orkestral que o serviço enxerga
sudo orkestral init
sudo systemctl enable --now orkestral
```

Logs: `journalctl -u orkestral -f`

> No bare-metal o daemon roda como **root**. Para um sandbox sem root, use a
> Opção A (Docker).

---

## Parear o WhatsApp pelo terminal do servidor

`orkestral init` é interativo e mostra o QR code no terminal — leia com o app do
WhatsApp no celular (Aparelhos conectados → Conectar aparelho). Precisa de TTY,
por isso o `-it` no Docker (`docker compose run --rm -it orkestral init`) e o
`sudo orkestral init` na Opção B. A auth do canal fica persistida nos
volumes/diretórios de dados, então sobrevive a restart e re-deploy.

## Segredos e auth do agente

- **`ORKESTRAL_SECRET_KEY`** (obrigatória): cifra os segredos. Docker: no `.env`.
  Bare-metal: em `/etc/orkestral/env` (o install.sh gera uma se faltar).
- **Auth do agente** (Claude/Codex/Gemini): o CLI do agente que o Orkestral spawna
  herda estas vars de ambiente. Defina a do seu provedor **ou** configure a key
  pela página Provedores (guardada cifrada no secret store):
  - Claude → `ANTHROPIC_API_KEY` (ou `CLAUDE_CODE_OAUTH_TOKEN`)
  - Codex → `OPENAI_API_KEY`
  - Gemini → `GEMINI_API_KEY`

  Docker: descomente a linha no `docker-compose.yml` (ou coloque no `.env`).
  Bare-metal: descomente no `/etc/orkestral/env` e `sudo systemctl restart orkestral`.

## Diretórios de dados (o que persistir)

| Diretório             | Conteúdo                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `~/.orkestral`        | SQLite (`instances/default`), workspaces, auth de canal                                                     |
| `~/.config/Orkestral` | userData do Electron: `secret.key`, `cli-history`, `channels/whatsapp` (Baileys), bins baixados sob demanda |

No Docker esses dois são volumes nomeados (`orkestral-data`, `orkestral-config`).
Os modelos de embedding baixam sob demanda em runtime — não vêm na imagem.

## Ver logs

- Docker: `docker compose logs -f`
- systemd: `journalctl -u orkestral -f`
- Status pontual: `docker compose run --rm orkestral status` ou `orkestral status`
  (use `orkestral status --require-channel` pra exigir um canal conectado).

## Atualizar

**Docker:**

```bash
git pull
docker compose build
docker compose up -d
```

**Bare-metal:** o `install.sh` é idempotente (não sobrescreve `/etc/orkestral/env`).

```bash
cd /opt/orkestral && git pull
sudo /opt/orkestral/install.sh   # reinstala deps + rebuilda
sudo systemctl restart orkestral
```
