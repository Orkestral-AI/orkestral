# Desktop Pet — Spec

Mascote flutuante do Orkestral: janela always-on-top que fica por cima de qualquer app,
mostra o status dos agentes em tempo real e notifica quando algo termina — sem precisar
de alt-tab pro app principal. Referência de UX: pet do Codex (OpenAI).

## Resumo

- Janela Electron secundária: transparente, sem moldura, `alwaysOnTop`, visível em todos
  os workspaces/fullscreen, arrastável pra qualquer canto da tela.
- Sprite com estados (idle / trabalhando / concluído / erro) dirigidos pelos push events
  que já existem no `pushBus` — zero mudança no motor.
- Stack de cards de notificação acima do sprite; clique abre a sessão/issue no app.
- Feature 100% desktop — não existe no `orkestral serve` (web).

## Contexto e objetivo

O Orkestral pilota agentes que rodam por minutos em background. Hoje o usuário sai pra
outro app e não tem sinal visível de "terminou" ou "deu erro" a não ser que volte pro
Orkestral ou olhe o tray. O pet resolve isso com presença permanente e discreta na tela.

Princípios:

1. **Nunca atrapalhar.** Clique atravessa a janela fora do sprite/cards. Sem roubo de foco.
2. **Motor intocado.** O pet é só um consumidor a mais dos eventos existentes.
3. **Desligável.** Toggle no tray e nas Configurações; estado persiste.

## UX

### Sprite e estados

| Estado | Gatilho | Visual |
|--------|---------|--------|
| `idle` | Nenhum agente ativo | Respiração lenta, olhos piscando |
| `working` | >= 1 execução ativa | Animação de atividade + badge com contagem de agentes ativos |
| `done` | Execução terminou com sucesso (transitório ~5s, volta pro estado real) | Pulo/celebração |
| `error` | Execução terminou com erro (fica até o card ser dispensado) | Expressão de erro, cor `status-error` |
| `attention` | Proposta nova na inbox aguardando (opt-in) | Aceno periódico discreto |

### Interações

- **Arrastar**: segurar o sprite move a janela (`-webkit-app-region: drag` na área do
  sprite). Posição persiste por display.
- **Clique no sprite**: abre menu contextual (Abrir Orkestral, Ocultar pet, Configurações).
- **Clique num card**: foca a janela principal e navega pra sessão/issue do evento.
- **Botão de colapso** (chevron, como no Codex): esconde os cards, mantém só o sprite.
- **Fora do sprite/cards**: clique atravessa (click-through) — o pet não bloqueia a tela.

### Notificações (cards)

- Stack vertical acima do sprite, mais recente no topo, máx. 3 visíveis (resto em fila).
- Card: título (nome da issue/sessão), subtítulo (status), ícone de estado (lucide,
  sem emoji).
- Auto-dismiss: sucesso em 8s; erro fica até clique/dispensa manual.
- Som opcional reaproveita `system.notificationSound` das settings.

## Arquitetura

### Janela (main process)

Novo módulo `src/main/pet/pet-window.ts`, criado a partir do boot em `src/main/index.ts`
(mesmo lugar que cria a mainWindow e o tray hoje — `src/main/index.ts:95-192` e `:247-289`):

```ts
new BrowserWindow({
  width: 360, height: 480,          // área útil; conteúdo ancora no canto inferior
  transparent: true, frame: false, hasShadow: false,
  alwaysOnTop: true, skipTaskbar: true, resizable: false,
  focusable: false,                  // não rouba foco; cliques ainda funcionam
  webPreferences: { preload: <preload desktop>, contextIsolation: true }
})
petWindow.setAlwaysOnTop(true, 'screen-saver')                 // acima de fullscreen
petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
petWindow.setIgnoreMouseEvents(true, { forward: true })        // click-through default
```

Click-through seletivo: o renderer do pet monitora `mouseenter`/`mouseleave` nas áreas
interativas (sprite, cards, chevron) e chama `pet:set-ignore-mouse` pra ligar/desligar o
`setIgnoreMouseEvents`. Padrão consolidado em apps Electron de overlay.

Posição: `petWindow.on('moved')` salva bounds + display id nas settings (debounce 500ms).
No boot, restaura validando que o display ainda existe; senão, canto inferior direito do
display primário.

### Renderer (segunda entry)

Hoje o electron-vite tem uma entry única de renderer (`src/renderer/index.html` —
`electron.vite.config.ts`). O pet vira a segunda:

- `src/renderer/pet.html` + `src/renderer/src/pet/main.tsx` (input adicional no rollup
  do renderer).
- App React mínimo: sem router, sem AppShell — só sprite + stack de cards.
- Reusa o preload desktop existente (`window.orkestral` / `window.orkestralEvents`).
- **Não** importa `web-bridge.ts` (pet nunca roda no browser).

### Fonte de status (push events existentes)

O pet **assina eventos que já existem** — nada novo no motor:

| Evento (pushBus/broadcast) | Uso no pet |
|----------------------------|------------|
| `issue:execution-event` | Estados started/finished/error → sprite + cards. Mesma fonte do `agentStatusStore` do app |
| `chat:stream` | Resposta do agente no chat: `message-start` → working; `message-end` done/error → done/erro + card pra `#/session/:id`; cancelled limpa sem card. Eventos `synthetic` (espelho de issue) são ignorados — contariam dobrado |
| `chat:session-ready` | Card "sessão pronta" |
| `inbox:proposal-created` | Estado `attention` + card (opt-in) |
| `update:downloaded` | Card "atualização disponível" |

Hidratação ao abrir: **não há canal de "execuções ativas agora"** (`agent:get-activity-stats`
é estatística histórica por agente — premissa original do spec estava errada). O pet abre
em idle e converge no primeiro evento; mesma fonte de verdade do `agentStatusStore`, que
também só vive de eventos.

A lógica evento → estado do sprite é uma **função pura** (`derivePetState(events)`) em
`src/renderer/src/pet/pet-state.ts` — testável com vitest (config node-only do repo).

### IPC novo (todos desktop-only)

Declarados no `IpcContract` (`src/shared/ipc-contract.ts`) e adicionados em
`GATEWAY_WEB_UNAVAILABLE_CHANNELS` (`src/shared/gateway.ts:28-61`) — no web retornam 403,
mesmo tratamento de `window:*`/`voice:*`:

| Canal | Direção | Função |
|-------|---------|--------|
| `pet:set-ignore-mouse` | invoke | Liga/desliga click-through (`{ ignore: boolean }`) |
| `pet:open-target` | invoke | Foca mainWindow + navega (`{ route: string }`); reusa a lógica do `system:focus-window` (`src/main/ipc/handlers/system.ts:37-53`) |
| `pet:set-enabled` | invoke | Mostra/esconde o pet (settings + destroy/create window) |

Sem push events novos → não mexe na regra de espelhamento preload/web-bridge.

### Settings

Nova seção na chave `app` do settings repo (Drizzle key-value,
`src/main/db/repositories/settings.repo.ts`):

```ts
pet: {
  enabled: boolean            // default false (opt-in no lançamento)
  bounds: { x: number; y: number; displayId: number } | null
  collapsed: boolean          // cards escondidos, só sprite
  notifications: {
    execution: boolean        // default true
    inbox: boolean            // default false
    updates: boolean          // default true
  }
  sound: boolean              // segue system.notificationSound como default
  size: 'sm' | 'md'           // escala do sprite
}
```

UI: bloco "Pet" na página de Configurações existente (settings:get/update já cobrem).

### Tray

Item novo no menu do tray (`src/main/index.ts:247-289`): "Ocultar pet" / "Mostrar pet"
(label dinâmico pelo estado), como no Codex (screenshot de referência).

## Fases

### Fase 0 — Fundação da janela

Pet aparece, flutua, arrasta, esconde. Sprite placeholder estático (SVG/PNG único).

- `pet-window.ts` com todas as flags (transparent, screen-saver, workspaces, click-through).
- Segunda entry no electron-vite (`pet.html`).
- Drag + persistência de posição por display.
- Toggle: tray + settings (`pet.enabled`) + `pet:set-enabled`.
- Canais no `GATEWAY_WEB_UNAVAILABLE_CHANNELS`.

Aceite: pet visível por cima de app fullscreen; clique fora do sprite atravessa; posição
sobrevive a restart; "Ocultar pet" no tray funciona; `orkestral serve` responde 403 nos
canais `pet:*`; typecheck verde.

### Fase 1 — Status core

Sprite reflete a realidade dos agentes.

- Assinatura de `issue:execution-event` (sem hidratação — ver "Fonte de status").
- `reducePetState()`/`derivePetVisual()` puras + testes vitest.
- Estados idle/working/done/error com badge de contagem (sem animação rica ainda —
  troca de cor/expressão basta).

Aceite: disparar execução de issue → pet entra em `working` com badge; terminar → `done`
5s e volta; erro → `error` persistente.

### Fase 2 — Cards de notificação

O valor de verdade: saber o que terminou sem abrir o app.

- Stack de cards (máx. 3 + fila), auto-dismiss, dispensa manual.
- Clique no card → `pet:open-target` → foca app na sessão/issue.
- Chevron de colapso (persistido em `pet.collapsed`).
- Filtros por tipo de evento nas settings (`pet.notifications.*`).
- Som opcional.

Aceite: execução termina com o app minimizado → card aparece; clique abre o app na issue
certa; colapso persiste.

### Fase 3 — Arte e personalidade

- Sprite = **vetor facetado** (decisão revisada: em vez de sprite sheet pixel art, o pet é
  uma criatura de cristal low-poly na linguagem do logo — SVG + animações CSS, zero asset
  binário, nítido em qualquer escala).
- Micro-interações: hover, clique, transições entre estados.
- Estado `attention` (inbox) com aceno.
- Respeitar `prefers-reduced-motion`.

Aceite: cada estado tem animação própria; CPU do pet em idle ~0% (animação pausa quando
estável).

### Fase 4 — Polimento

- Multi-monitor: posição por display, fallback quando display some.
- Tamanho `sm`/`md` nas settings.
- Quiet hours / modo não perturbe (sem cards, só estado do sprite).
- Easter eggs (clique repetido, datas).
- Auto-hide opcional quando a mainWindow está focada.

## Fora de escopo

- Pet no `orkestral serve` (browser) — desktop-only por definição.
- Notificações nativas do SO — já existem por outro caminho; pet não duplica.
- Interação por chat/voz com o pet.

## Riscos e gotchas

| Risco | Mitigação |
|-------|-----------|
| `transparent: true` tem quirks por SO (resize/sombra) | Janela `resizable: false`, `hasShadow: false`; testar nos 3 SOs |
| Click-through seletivo com `forward: true` é macOS-friendly, mas o forward não funciona igual no Linux | Aceitar degradação: no Linux, click-through só total (sem forward de hover); documentar |
| `focusable: false` no Windows pode impedir drag nativo | Fallback: drag manual via mousedown + `setPosition` |
| Janela extra = processo renderer extra (~50MB) | Só cria quando `pet.enabled`; destroy no disable |
| `screen-saver` level compete com outros overlays | Nível configurável se conflitar; default `screen-saver` |
| Badge desatualiza se push perde evento | Sem canal de "ativos agora" pra re-hidratar (limitação conhecida); badge converge no próximo started/finished. Se doer na prática, criar invoke `pet:get-active` lendo o estado do issue-execution-service |

## Validação

Padrão do repo: vitest só pra lógica pura (`derivePetState`, fila de cards, validação de
bounds); UI e janela = `npm run typecheck` (node + web) + teste manual nos cenários de
aceite de cada fase. Lint repo-wide tem erros pré-existentes — gate é o typecheck.
