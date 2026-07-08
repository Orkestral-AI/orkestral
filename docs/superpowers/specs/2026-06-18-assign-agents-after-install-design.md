# Modal "Atribuir a agentes" pós-install — Design

Data: 2026-06-18
Status: aprovado (design), pendente revisão do spec

## Problema

Ao instalar uma Skill ou MCP pela marketplace, o fluxo termina em
`toast.success()` + fechar dialog. Pra definir **quais agentes usam** o item,
o usuário precisa abrir cada agente, ir na aba de skills/ferramentas e atribuir
um a um. Atrito alto e fácil esquecer de atribuir.

## Objetivo

Logo após o install concluir, abrir um modal que mostra os agentes do workspace
em cards (com avatar) e permite ligar/desligar o item recém-instalado em cada
agente, com botão "marcar/desmarcar todos". Reduz o fluxo a 1 tela.

## Decisões (brainstorming)

- **Escopo:** modal cobre Skills **e** MCPs. MCP é tratado "por agente" na UI,
  traduzido pra model scopes por baixo. (Opção B)
- **Gatilho/default:** aparece **sempre** após install, com **todos os agentes
  já marcados**. Botão alterna "Marcar todos / Desmarcar todos". (Opção A)
- **MCP irmãos:** MCP guarda ativação por modelo, não por agente. Agentes do
  mesmo modelo são "irmãos". Marcar/desmarcar um **arrasta os irmãos junto**,
  com indicação visual e aviso inline. (Opção B)
- **Visual:** card clicável por agente (não checkbox cru) — `AgentAvatar` +
  nome + título + badge do modelo. Estado selecionado destacado com
  `primary`/outline (proibido `secondary`/ciano).

## Arquitetura

### Componente novo

`src/renderer/src/components/marketplace/AssignAgentsDialog.tsx`

Props:

- `item: Skill` (o item recém-instalado; usa `item.kind` pra ramificar skill vs mcp)
- `workspaceId: string`
- `open: boolean`
- `onClose: () => void`

Dados que carrega (TanStack Query):

- `agent:list` → `{ workspaceId }` → lista de agentes (data source dos cards)
- Se skill instruction: `skill:list-by-agent` por agente OU um fetch do estado
  atual de attach pra pré-marcar (default = todos marcados, então só precisa do
  estado atual se quisermos refletir realidade; ver "Estado inicial").

### Estado inicial dos cards

- Default: **todos marcados** (decisão A), independente do estado atual.
  - Racional: caso comum é "ativar em todos". Salvar reconcilia o estado real.

### Layout do card

- `AgentAvatar` (reusa `components/agents/AgentAvatar.tsx`, seed = `avatarSeed`).
- Nome (`agent.name`), título (`agent.title`/`agent.role`).
- Badge do modelo: `agent.adapterType` (ex: `claude_local`).
- Selecionado: borda/realce `primary`. Não selecionado: `outline`/`muted`.
- Clique no card alterna seleção (`role="button"`, trata Enter e Space).

### Topo do modal

- Botão "Marcar todos / Desmarcar todos" (texto alterna conforme estado agregado).
- Contador "X de Y selecionados".

### Footer

- "Salvar" (primary) — aplica e fecha.
- "Pular" (outline/ghost) — fecha sem mudar nada além do que o install já fez.

## Comportamento ao salvar

### Item = Skill (kind = 'instruction')

Liga por agente de verdade via pivot `agent_skills`.

- Lê estado atual via `skill:list-by-agent` (ou um fetch agregado).
- Para cada agente marcado que NÃO estava → `skill:attach({ agentId, skillId })`.
- Para cada agente desmarcado que ESTAVA → `skill:detach({ agentId, skillId })`.
- Sem endpoint novo; usa os existentes. Invalida queries
  `['skills-by-agent', agentId]` e `['skills', workspaceId]`.

### Item = MCP (kind = 'mcp')

Liga por **model scope** (`config.marketplace.modelInstalls[]`), não por agente.

- Cada agente mapeia pra um scope `adapterType:model` (via helper
  `deriveScopeOptions` em `marketplace/shared.ts`).
- **Arrastar irmãos:** agentes do mesmo modelo compartilham scope. Toggle de um
  reflete em todos os irmãos imediatamente na UI (cards irmãos atualizam juntos).
- Marca visual: cards do mesmo modelo recebem indicação (ex: tag de modelo
  destacada) + aviso inline quando o usuário mexe ("Vendas usa o mesmo modelo,
  será incluído").
- Salvar = `marketplace:set-model-scopes({ skillId, modelScopes })` com a
  **união dos scopes** dos agentes marcados.
  - Se TODOS os agentes de um adapter estão marcados → pode usar `*` (todos os
    modelos daquele adapter). Senão, scopes específicos.

## Mudanças no fluxo de install existente

### Gatilho do modal

Hoje (sucesso de install):

- `ItemDetailDialog.tsx`: `toast.success()` → `onChanged()` → `onClose()`.
- `MarketplaceBrowser.tsx` (quick-install): `toast.success()` → `refetch()`.

Novo: após o `toast.success()`, abrir `AssignAgentsDialog` com o item criado.

- `ItemDetailDialog`: substitui o `onClose()` imediato por abrir o assign dialog;
  ao fechar o assign, chama `onChanged()` + `onClose()`.
- `MarketplaceBrowser`: após quick-install, abre o assign dialog com o item
  retornado; ao fechar, `refetch()`.

### Remover auto-attach-all de instruction

Hoje `skills-issues.ts` (~linha 566) ao instalar skill `kind='instruction'` faz
loop attach em TODOS os agentes. Com o modal dirigindo a atribuição, **remover
esse loop**. Default "todos marcados" no modal preserva o comportamento de
"liga em todos" quando o usuário só clica Salvar, mas agora ele pode refinar.

## Tratamento de erros

- Falha em `skill:attach`/`detach`/`set-model-scopes` → `toast.error` com a key
  i18n apropriada; não fecha o modal (usuário pode tentar de novo).
- Sem agentes no workspace → modal mostra estado vazio com mensagem e só "Fechar".

## i18n

- Novas keys em `pages.marketplace.*` (ou `components.assignAgents.*`): título,
  botões marcar/desmarcar todos, contador, aviso de irmãos, estado vazio,
  toasts de sucesso/erro. Sem string hardcoded.

## Fora de escopo (YAGNI)

- Editar atribuição depois pelo "Installed" tab (reusar o mesmo modal é trivial
  no futuro, mas não entra agora).
- Mudar o mecanismo de MCP pra pivot por agente (mudança grande de modelo de
  dados; mantemos model scope).
- `kind='tool'` (não usado na UI hoje).

## Arquivos afetados (estimativa)

- **Novo:** `src/renderer/src/components/marketplace/AssignAgentsDialog.tsx`
- **Edit:** `src/renderer/src/components/marketplace/ItemDetailDialog.tsx`
- **Edit:** `src/renderer/src/components/marketplace/MarketplaceBrowser.tsx`
- **Edit:** `src/main/ipc/handlers/skills-issues.ts` (remover auto-attach-all)
- **Edit:** arquivos de i18n (messages)
- **Reuso:** `components/agents/AgentAvatar.tsx`, `marketplace/shared.ts`
  (`deriveScopeOptions`), endpoints `agent:list`, `skill:attach`, `skill:detach`,
  `skill:list-by-agent`, `marketplace:set-model-scopes`.
