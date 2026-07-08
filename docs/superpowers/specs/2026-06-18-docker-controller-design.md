# Spec — Controlador de Container no Orkestral (estilo OrbStack)

Data: 2026-06-18
Status: aprovado para planejamento (aguardando review do spec)
Autor: Luccas + Claude

---

## 1. Contexto e objetivo

O Orkestral já é um ambiente único de dev: IDE embutida (CodeMirror), git, terminal
integrado (node-pty + xterm) e preview. Falta uma peça pra fechar o "tudo em 1 lugar":
um **controlador de containers** — listar, subir/parar, ver logs em tempo real, métricas
(CPU/RAM) e abrir shell dentro do container — sem precisar abrir OrbStack/Docker Desktop
à parte.

Objetivo declarado pelo Luccas:

1. **Tudo em 1 lugar** — gerenciar containers de dentro do Orkestral.
2. **Mais leve/fluido que OrbStack** — OrbStack hoje puxa muita RAM.

---

## 2. Princípio central: UI (controlador) ≠ Engine (motor)

A distinção que orienta todo o spec:

| Camada               | O que faz                                                   | Custo de RAM      |
| -------------------- | ----------------------------------------------------------- | ----------------- |
| **Engine** (motor)   | Roda os containers de verdade (no mac/win = VM Linux)       | **Alto** — é a VM |
| **UI / Controlador** | Lista, comanda, mostra logs/stats. Só conversa com o engine | Baixo             |

Consequência que define o roadmap:

- Construir a **UI controladora** (Fase 1) → leve, encaixa limpo, dá o "tudo em 1 lugar".
  **Mas sozinha não reduz a RAM dos containers** — quem come RAM é o engine.
- A leveza real (objetivo 2) vem de **qual engine roda por baixo** → tratada na Fase 2,
  e é um problema **específico de cada SO** (ver seção 3).

Não vamos construir engine próprio (VM nativa estilo OrbStack/Apple). É um projeto gigante
de virtualização — fora de escopo. Reusamos engines existentes.

---

## 3. Realidade cross-platform (mac / win / linux)

O Orkestral distribui pros três SOs (`dist:mac`, `dist:win`, `dist:linux`). Isso afeta as
duas camadas de forma diferente:

### Transporte (UI → engine) — resolvido de forma uniforme

`dockerode` fala com o engine pelo mesmo protocolo em todos os SOs, mudando só o endpoint:

| SO            | Endpoint padrão do engine           |
| ------------- | ----------------------------------- |
| macOS / Linux | unix socket `/var/run/docker.sock`  |
| Windows       | named pipe `//./pipe/docker_engine` |

→ A **Fase 1 é cross-platform "de graça"**: só detectar o endpoint certo por SO.

### Engine (motor) — situação diferente por SO

| SO          | Como o Docker roda                                              | Precisa de VM? | "Leveza" é problema?        |
| ----------- | --------------------------------------------------------------- | -------------- | --------------------------- |
| **Linux**   | `dockerd` **nativo** no kernel do host                          | **Não**        | Não — já é leve             |
| **macOS**   | Dentro de uma **VM Linux** (Docker Desktop / OrbStack / Colima) | Sim            | **Sim**                     |
| **Windows** | Dentro de **WSL2** (Docker Desktop / Rancher) ou VM             | Sim (WSL2)     | Sim, mas WSL2 já é razoável |

→ A **Fase 2 (leveza) é por-SO**. O problema que motivou o pedido ("OrbStack pesa") é
essencialmente **macOS**. No Linux não existe; no Windows o caminho é WSL2.

---

## 4. Decisões travadas

| #   | Decisão                   | Escolha                                                                                                                                                                                         |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Escopo de ações da Fase 1 | **Controle completo + exec**: list, start/stop/restart/remove, logs em tempo real, stats CPU/RAM, exec (shell no container reusando o terminal xterm). Imagens/volumes/networks: leitura na F1. |
| D2  | Agrupamento Compose       | **Sim** — agrupar containers por `com.docker.compose.project` (igual lazydocker).                                                                                                               |
| D3  | Estratégia de engine (F2) | **Detectar + auto-gerenciar** (por-SO): F1 conecta no engine existente; F2 instala/sobe engine leve quando não houver.                                                                          |
| D4  | Transporte                | **dockerode** no socket/named pipe (JS puro, sem rebuild nativo, streaming nativo).                                                                                                             |

---

## 5. Não-objetivos (YAGNI)

- Não construir engine/VM próprio.
- Não suportar Docker Swarm, Kubernetes, multi-host/remoto (foco = engine local). Portainer
  que cuide disso.
- Não editar/buildar imagens (build de Dockerfile) na F1 — só usar imagens existentes.
- Não fazer editor visual de `docker-compose.yml` — só ler/agrupar por projeto e
  up/down do projeto (up/down fica pra F1.5, ver seção 6.6).
- Sem gerenciamento de registries/login na F1.

---

## 6. Fase 1 — Controlador (cross-platform, qualquer engine)

Funciona em mac/win/linux conectando em **qualquer engine já instalado** (Docker Desktop,
OrbStack, Colima, Rancher, Podman com socket compatível). **Não instala nada.** Se não achar
engine, mostra estado vazio com instrução (a instalação é da Fase 2).

Toda a feature **espelha o padrão do terminal integrado** — que já resolve "processo longo

- streaming via IPC + cleanup". Esse é o molde de referência.

### 6.1 Detecção e conexão

- Novo `docker-service.ts` instancia `dockerode` com `socketPath` resolvido por SO
  (seção 3). Permitir override por env/config (`DOCKER_HOST`) pra cobrir Colima/Podman que
  expõem socket em outro caminho.
- Healthcheck: `docker.ping()` na inicialização do painel e num polling leve. Estados:
  `connected` | `no-engine` | `error`.
- A conexão é **lazy**: só conecta quando o painel Docker abre (não pesar o boot do app).

### 6.2 Contrato IPC

Adicionar canais em `src/shared/ipc-contract.ts` (fonte única de tipos; o preload monta
`window.orkestral[<canal>]` automaticamente). Canais request/response:

- `docker:ping` → status do engine
- `docker:list-containers` → containers (já com label de compose)
- `docker:list-images`, `docker:list-volumes`, `docker:list-networks`
- `docker:container-action` → `{ id, action: 'start'|'stop'|'restart'|'remove' }`
- `docker:inspect` → `{ id }` detalhes
- `docker:logs-start` / `docker:logs-stop` → controla stream de logs
- `docker:stats-start` / `docker:stats-stop` → controla stream de stats
- `docker:exec-start` → abre sessão exec (ver 6.5)

Eventos (main → renderer, streaming) entregues por broadcast, padrão do terminal:

- `docker:logs-data` → `{ id, chunk }`
- `docker:stats-data` → `{ id, cpu, memUsed, memLimit, net, block }`
- `docker:containers-changed` → invalidação pra refetch (eventos do Docker)

### 6.3 Serviço no main

`src/main/services/docker-service.ts` (espelha `terminal-service.ts` e `git-service.ts`):

- `ping()`, `listContainers()`, `listImages()`, `listVolumes()`, `listNetworks()`,
  `inspect(id)`, `containerAction(id, action)`.
- `startLogsStream(id)` / `startStatsStream(id)` — guardam streams ativos num
  `Map<id, stream>`; em cada chunk chamam `broadcast(canal, payload)`
  (mesmo `broadcast()` que `webContents.send` pra todas janelas vivas, como o terminal).
- `stopLogsStream(id)` / `stopStatsStream(id)` / `killAllStreams()` — cleanup.
- Assinar o **event stream do Docker** (`docker.getEvents()`) pra emitir
  `docker:containers-changed` quando algo nasce/morre, em vez de polling agressivo.

Handlers: `src/main/ipc/handlers/docker.ts`, registrado em `src/main/ipc/index.ts`
(seguir o padrão de `terminal.ts` / `git.ts`).

Cleanup global: chamar `killAllStreams()` no `before-quit` do app.

### 6.4 Streaming de logs e stats

- **Logs**: `dockerode` `container.logs({ follow: true, stdout: true, stderr: true })`
  retorna stream → demux (header de 8 bytes do Docker) → `broadcast('docker:logs-data')`.
- **Stats**: `container.stats({ stream: true })` → calcular % CPU e MB de RAM a partir do
  payload bruto → `broadcast('docker:stats-data')` (throttle ~1/s).
- Renderer faz buffering antes do componente montar (mesmo cuidado do `TerminalPanel.tsx`).
- Cleanup ao trocar de container / fechar painel (parar streams do container anterior).

### 6.5 Exec (shell dentro do container) — reusa o terminal

Maior reuso do projeto. node-pty **já está no projeto** (terminal).

- `docker:exec-start` cria um exec no container (`container.exec({ Cmd: ['/bin/sh'],
AttachStdin, AttachStdout, AttachStderr, Tty: true })`) e dá `hijack`/`resize`.
- O stream do exec é tratado **como mais uma sessão de terminal**: reaproveitar
  `terminalStore` / `terminalOutputStore` e o componente xterm do `TerminalPanel.tsx`,
  marcando a sessão como `kind: 'docker-exec'`. Assim ganhamos histórico, resize e UI
  de graça.
- Fallback: se o container não tiver `/bin/sh`, tentar `/bin/bash`; senão avisar.

### 6.6 Agrupamento por Docker Compose

- Containers trazem labels do Docker. Agrupar por `com.docker.compose.project` e ordenar por
  `com.docker.compose.service`. Containers soltos (sem label) vão num grupo "Avulsos".
- UI mostra árvore: Projeto → serviços/containers. Ação no nível do projeto
  (start/stop/restart de todos) — incremental, pode ficar numa **F1.5** se apertar o prazo.

### 6.7 Estado, UI e navegação

- **Store**: `src/renderer/src/stores/dockerStore.ts` (zustand, padrão dos outros stores).
  Guarda: status do engine, containers (agrupados), imagens/volumes/networks, logs por id,
  stats por id, container selecionado.
- **Painel**: `src/renderer/src/components/docker/DockerPanel.tsx`, modelado no
  `TerminalPanel.tsx`. Layout estilo lazydocker/OrbStack: lista (esquerda, agrupada por
  compose) + detalhe (direita) com abas **Logs | Stats | Inspect | Exec**.
- **Navegação**: novo item na `src/renderer/src/components/layout/Sidebar.tsx`
  (+ `SidebarItem.tsx`), ícone lucide-react (ex.: `Container` / `Boxes`). Sem emoji.
- **Resize**: reaproveitar o sistema de painel redimensionável do `uiStore.ts`.
- Reusar componentes do design system (`docs/DESIGN_SYSTEM.md`); nada de div+Tailwind cru
  pra UI que já existe como componente.

### 6.8 Erros e estados vazios

- `no-engine`: tela vazia explicando + botão/CTA que aponta pra Fase 2 (instalar engine
  leve). Em Linux: instrução de subir `dockerd`/permissão de socket.
- `error` (socket caiu / permissão): banner com mensagem e botão "tentar reconectar".
- Ações destrutivas (`remove`, `stop` em massa, prune) **sempre com confirmação explícita**.
- Toda mutation dá feedback (toast de sucesso/erro) — sem ação silenciosa.

### 6.9 Segurança

- Acesso ao socket do Docker = acesso privilegiado ao host. **Nunca** expor o socket via TCP
  nem por canal IPC genérico; só os canais tipados específicos.
- Validar `action`/`id` no handler (whitelist de ações) — não repassar input cru pro engine.
- Não logar conteúdo sensível de env de container em telemetria.

### 6.10 Critério de aceite — Fase 1

- [ ] Detecta engine em mac/win/linux; estado `no-engine` claro quando ausente.
- [ ] Lista containers agrupados por projeto compose, com status.
- [ ] start/stop/restart/remove funcionam, com confirmação no destrutivo e feedback.
- [ ] Logs em tempo real fluindo, com cleanup ao trocar/fechar.
- [ ] Stats CPU/RAM atualizando (~1/s).
- [ ] Exec abre shell no container reusando o terminal xterm.
- [ ] `npm run typecheck` (node+web) passa. Sem regressão de lint nos arquivos tocados.

---

## 7. Fase 2 — Leveza / gerência de engine (por-SO)

Objetivo: não depender de OrbStack/Docker Desktop e, no mac, ficar leve. Estratégia
**detectar + auto-gerenciar**, ramificada por SO.

| SO          | Estratégia F2                                                                                                                                                   | Resultado                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Linux**   | Detectar `dockerd` nativo; se faltar, instruir instalação (não embutir). Sem VM.                                                                                | Já leve; só conectar           |
| **macOS**   | Se nenhum engine, Orkestral **instala/sobe Colima** (`--vm-type vz` + virtiofs) e conecta no socket dele. Memória dinâmica, idle ~350MB vs Docker Desktop 3-4GB | Leve, independente de OrbStack |
| **Windows** | Detectar WSL2 + engine; se faltar, guiar setup de WSL2/engine. Auto-instalar é arriscado → preferir guiar                                                       | Razoável via WSL2              |

Detalhes macOS (o caso central):

- Gerenciar ciclo de vida do Colima via CLI no main (padrão `git-service`/`smart-exec`):
  `colima start --vm-type vz --mount-type virtiofs`, `colima status`, `colima stop`.
- Orkestral vira o "dono" do engine: sobe sob demanda quando o painel abre, derruba quando
  ocioso (opcional) pra economizar RAM.
- Trade-off conhecido: FS I/O do Colima é mais lento que OrbStack (virtiofs ajuda, mas não
  iguala). Documentar.
- Bundling do binário Colima vs instalar on-demand (brew/download) = **decisão aberta**
  (ver seção 9).

Critério de aceite F2:

- [ ] mac sem engine: Orkestral sobe Colima e o painel da F1 funciona ponta a ponta.
- [ ] RAM idle medida e documentada (alvo: bem abaixo de Docker Desktop).
- [ ] linux/win: detecção + instrução clara quando engine ausente.

---

## 8. Fase 3 — Futuro (opcional)

- **Apple `container`** (WWDC25, open source, Swift, 1 VM por container, boot <1s): só
  macOS 26+. Quando a base de usuários migrar, vira opção de engine ainda mais leve no mac.
  Hoje: só monitorar.
- Build de imagens, prune avançado, gráficos históricos de stats, suporte a compose up/down
  via arquivo, registries.

---

## 9. Riscos e decisões abertas

1. **Compatibilidade de engines via socket**: Podman/Rancher expõem socket "Docker-compatible"
   com pequenas diferenças. Risco baixo pra operações básicas; validar.
2. **Permissão de socket no Linux** (usuário fora do grupo `docker`): tratar erro com
   instrução clara.
3. **Bundling do Colima (F2)**: embutir binário (app maior) vs instalar on-demand
   (precisa rede/brew). A decidir no plano da F2.
4. **Auto-derrubar engine ocioso (mac)**: bom pra RAM, ruim se o user tem containers que
   devem ficar de pé. Provavelmente opt-in.
5. **dockerode + electron-builder**: dockerode é JS puro (não precisa rebuild como o
   better-sqlite3), mas confirmar que entra no bundle do main sem problema de empacotamento.

---

## 10. Dependências novas

- `dockerode` (+ `@types/dockerode`) — runtime dep do processo main. JS puro, sem rebuild
  nativo. **Já não está instalado** no projeto (confirmado).
- node-pty: **já presente** (reuso pro exec).
- Fase 2 mac: Colima (binário externo, não dep npm).

---

## 11. Arquivos-alvo (mapa de integração)

| Camada       | Arquivo (novo ou tocado)                                                        | Espelha                                 |
| ------------ | ------------------------------------------------------------------------------- | --------------------------------------- |
| Contrato IPC | `src/shared/ipc-contract.ts` (+)                                                | canais existentes                       |
| Serviço main | `src/main/services/docker-service.ts` (novo)                                    | `terminal-service.ts`, `git-service.ts` |
| Handlers     | `src/main/ipc/handlers/docker.ts` (novo) + registrar em `src/main/ipc/index.ts` | `handlers/terminal.ts`                  |
| Preload      | exposição automática via contrato                                               | —                                       |
| Store        | `src/renderer/src/stores/dockerStore.ts` (novo)                                 | `terminalStore.ts`                      |
| UI painel    | `src/renderer/src/components/docker/DockerPanel.tsx` (novo)                     | `code-ide/TerminalPanel.tsx`            |
| Navegação    | `src/renderer/src/components/layout/Sidebar.tsx` + `SidebarItem.tsx` (+)        | itens atuais                            |
| Resize       | `src/renderer/src/stores/uiStore.ts` (reuso)                                    | —                                       |
| Cleanup      | `before-quit` no bootstrap do main (+)                                          | cleanup do terminal                     |
