# Signal Channel — Spec

**Data:** 2026-06-22
**Status:** proposto
**Autor:** Luccas + Claude

## 1. Objetivo

Adicionar o **Signal** como canal de mensageria do Orkestral, no mesmo modelo dos canais
existentes (WhatsApp/Telegram): o usuário conversa com um agente por DM no Signal, e as
mensagens entram no mesmo pipeline de sessão/fila/streaming.

## 2. Decisões (já tomadas)

| Decisão                     | Escolha                                                                | Por quê                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Identidade do bot           | **Linkar conta existente via QR**                                      | Usuário já tem Signal no celular; bot vira um _dispositivo linkado_ (igual Signal Desktop). Reusa o fluxo de QR do WhatsApp. |
| Entrega do `signal-cli`     | **Baixar sob demanda**                                                 | Mesmo padrão do Whisper/Forge (`download-manager` + pack manifest). Sem exigir Docker.                                       |
| Transporte                  | **`signal-cli jsonRpc` (stdio)**                                       | Daemon local, comunicação por stdin/stdout. Saída/local — **sem webhook/túnel** (igual long-polling do Telegram).            |
| Persistência de credenciais | **Dir de config file-based** (`userData/channels/signal/<accountId>/`) | Igual o token do Telegram — **sem migration**.                                                                               |

## 3. Por que Signal é diferente (contexto)

Signal **não tem Bot API oficial** (não existe "@BotFather"). A identidade é um **número de
telefone**. A integração usa o **`signal-cli`** (ferramenta da comunidade, JVM) que age como um
_cliente/dispositivo Signal_. O Orkestral fala com o `signal-cli` localmente via JSON-RPC.

Linkar (Path A) = `signal-cli link` gera um URI `sgnl://linkdevice?...` → renderizamos como **QR**
→ usuário escaneia em **Signal > Configurações > Dispositivos vinculados > Vincular novo**.
O bot passa a ser um dispositivo da conta do usuário (mesmo número).

## 4. Arquitetura

```
Signal app (celular) ──linka via QR──▶ signal-cli (daemon jsonRpc, local)
                                              │ stdin/stdout (JSON-RPC)
                                              ▼
                            SignalConnection (implements ChannelConnection)
                                              │ onMessage / onQr / onConnected
                                              ▼
                            channel-manager (handleInbound → enqueueChatMessage)
                                              ▲ onChatStreamEvent (streaming por edição)
                                              │
                                       chat-service / agente
```

`SignalConnection` espelha `TelegramConnection`: mesma interface `ChannelConnection`, emite
`InboundChannelMessage` (tipo compartilhado), guarda sua própria chave de mensagem (timestamp do
Signal) pra editar no streaming.

### 4.1 Componentes novos

| Arquivo                                           | Responsabilidade                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/services/channels/signal-cli-pack.ts`   | Download/status/install do `signal-cli` + JRE mínima sob demanda (mirror de `voice-pack-manager`). Manifest por plataforma.            |
| `src/main/services/channels/signal-connection.ts` | Gerencia o processo `signal-cli` (link + daemon jsonRpc), parseia receive, envia/edita, typing, media. Implementa `ChannelConnection`. |
| `src/main/services/channels/signal-jsonrpc.ts`    | Framing JSON-RPC sobre stdio (encode request, decode notifications/replies). **Funções puras** — testáveis.                            |
| `src/main/services/channels/signal-link-uri.ts`   | Extrai o URI `sgnl://linkdevice?...` da saída do `signal-cli link`. **Função pura** — testável.                                        |

### 4.2 Mudanças em arquivos existentes

| Arquivo                                                            | Mudança                                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `src/shared/types/index.ts`                                        | `ChannelType` += `'signal'`.                                                                 |
| `src/main/services/channels/channel-manager.ts`                    | `openConnection` ganha branch `signal` → `buildSignalConnection`.                            |
| `src/main/ipc/handlers/channels.ts` + `src/shared/ipc-contract.ts` | `channels:signal-cli-status` + `channels:install-signal-cli` (status/instalação do binário). |
| `src/renderer/src/components/chat/ChannelIcon.tsx`                 | path do logo Signal (`#3A76F0`).                                                             |
| `src/renderer/src/pages/ChannelsPage.tsx`                          | brand `SIGNAL` + `SignalModal` (agente + allowlist + QR + progress de download).             |
| i18n `pt-BR`/`en` (`pages.json`)                                   | textos do canal Signal.                                                                      |
| `src/renderer/src/pages/SessionPage.tsx`                           | `CHANNEL_LABEL.signal = 'Signal'` (já é channel-aware).                                      |

## 5. Fluxos

### 5.1 Conectar (1ª vez — não linkado, signal-cli ausente)

1. Usuário abre o card **Signal** → escolhe agente + allowlist → **Conectar**.
2. `channels:connect` → `buildSignalConnection`:
   - Se `signal-cli` ausente → dispara download (progress via `channels:signal-cli-progress`,
     UI mostra barra igual voice pack). Conta fica `connecting` com `lastError` informativo.
   - Após instalado, roda `signal-cli --config <dir> link -n "Orkestral"`.
   - Captura o URI `sgnl://linkdevice?...` da stdout → `onQr(uri)` → `QRCode.toDataURL` →
     `qrByAccount` + status `qr` (reusa exatamente o fluxo do WhatsApp).
3. UI mostra o QR + instrução. Usuário escaneia no Signal do celular.
4. `signal-cli link` completa (processo encerra ok) → descobrir o número via `listAccounts`
   → grava `account` no dir → status `connected`, `selfId = <número>`.
5. Sobe o daemon: `signal-cli --config <dir> -a <account> jsonRpc` (stdio).

### 5.2 Conectar (já linkado)

- Dir de config tem conta → pula link/QR, sobe o daemon direto → `connected`.
- No boot (`initChannelService`), religa contas Signal que já têm conta linkada (mirror do
  re-link de Telegram/WhatsApp).

### 5.3 Inbound

- Daemon emite notificação JSON-RPC `receive` → `signal-jsonrpc` decodifica → extrai
  `{ from: <número/uuid>, text, senderNumber, pushName }` → `onMessage` →
  `handleInbound` (allowlist, sessão, fila, escolha de workspace — tudo já existe).
- Só **DM** no MVP (mensagens de grupo são ignoradas, igual Telegram private-only).

### 5.4 Outbound (streaming)

- `sendText(to, text)` → JSON-RPC `send` → retorna o **timestamp** da mensagem (vira `msgKey`).
- `editText(to, msgKey, text)` → JSON-RPC `sendEditMessage` com `targetTimestamp` → streaming
  por edição (igual WhatsApp/Telegram). **Fallback:** se a edição falhar/rate-limit, manda só
  o texto final uma vez (sem streaming).
- `sendTyping(to)` → JSON-RPC `sendTyping`.
- `sendMedia(to, buffer, ...)` → grava temp + `send` com `attachments: [path]`; limpa o temp
  no `finally` (padrão `tempnam cleanup`).

## 6. Dados / persistência

- **Sem migration.** Reusa `channel_accounts` (+ `channelType='signal'`) e `channel_sessions`.
- Credenciais do Signal = dir de config do `signal-cli` em `userData/channels/signal/<accountId>/`
  (file-based, igual token do Telegram). `deleteAccount` apaga esse dir (best-effort).
- `signal-cli` + JRE ficam em `resources`/userData via o pack-manager (fora do banco).

## 7. Segurança / robustez

- **Um daemon por conta** (Signal trava o account dir; 2 processos = erro). Garantir 1
  processo por `accountId` no `connections` map (já é por design).
- Binário baixado: `chmod +x` + remover quarantine no macOS (`xattr -d com.apple.quarantine`)
  — padrão já usado no voice pack (`chmodSync`).
- Validar `sha256` do download (igual voice pack) antes de usar.
- Nunca logar conteúdo de mensagem nem o link-URI cru em audit.
- Allowlist por número/uuid: vazia = responde todos; com itens = só eles (igual hoje).
- `signal-cli link` URI é sensível (permite linkar) — só vive em memória/QR efêmero, nunca
  persistido (mesmo tratamento do QR do WhatsApp).

## 8. Riscos / pontos de atenção

| Risco                                                   | Mitigação                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `signal-cli` precisa de **Java 21+**                    | Baixar JRE mínima (Adoptium/jlink) como 2º componente do pack, por plataforma. |
| Tamanho (~JRE 40MB + signal-cli 50MB por plataforma)    | Download sob demanda (não vai no instalador).                                  |
| Gatekeeper/quarantine no macOS ao rodar binário baixado | `xattr -d` + `chmod +x` (padrão do voice pack).                                |
| Drift de versão do signal-cli/protocolo                 | Pinar versão no manifest + `sha256`.                                           |
| Edição de mensagem (streaming) com rate-limit           | Fallback pra envio único do texto final.                                       |
| Limite de dispositivos linkados no Signal               | Documentar; usuário desvincula um antigo se bater no limite.                   |

## 9. Fora de escopo (MVP)

- Grupos / tópicos.
- Registrar número dedicado (Path B) — só linkar (Path A).
- Chamadas de voz/vídeo, mensagens que somem, reações.
- Sincronizar histórico antigo da conta.
- Multi-conta Signal simultânea (1 conta no MVP; arquitetura não impede mais depois).

## 10. Critério de pronto

- Conectar mostra QR; após escanear no celular, status vai a `connected` com o número.
- DM pro número linkado cai no agente; resposta volta com streaming por edição.
- `/help`, `/new`, `/workspace`, allowlist e escolha de workspace funcionam (reuso total).
- Ícone Signal aparece nos recentes (canal-aware já pronto).
- Gate: `typecheck:node` + `typecheck:web` + `eslint` limpos. Testes vitest pros 2 módulos
  puros (`signal-jsonrpc`, `signal-link-uri`).
