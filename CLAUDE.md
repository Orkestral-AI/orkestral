# CLAUDE.md — Orkestral

> Guia pra agentes de IA (Claude Code e afins) trabalharem neste repositório.
> Para contribuir como humano, veja **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Project Overview

App desktop (Electron) de orquestração de agentes de IA: workspaces, sources (repos/pastas), issues/épicas, goals, hiring de times, chat com agentes.

- **Stack**: Electron + electron-vite, React + TypeScript, Tailwind v4, Zustand, TanStack Query, React Router.
- **DB**: SQLite (better-sqlite3) via Drizzle ORM. Schema em `src/main/db/schema.ts`, migrations em `src/main/db/migrations.ts`.
- **Processos**: `src/main` (Node/Electron main), `src/renderer` (React UI), `src/shared` (tipos + contrato IPC). Comunicação via IPC tipado (`src/shared/ipc-contract.ts`).
- **Gate de qualidade**: `npm run typecheck && npm run lint && npm run format && npm run test` (vitest). Rodar antes de abrir um PR.

---

## Branches

- Nome de branch em inglês: `tipo/kebab-case` com prefixo Conventional (`feat/`, `fix/`, `hotfix/`, `chore/`, `refactor/`, `docs/`, `perf/`).
- Todo PR vem com um resumo curto neste formato:

```
## O que mudou

1. **Título curto** — o que muda e por quê, em uma linha.
2. **Título curto** — idem.
3. ...
```

Regras do resumo: numerado, **título em negrito** + uma linha; cobrir o que foi **adicionado** e o que foi **alterado**; curto e direto; sem emoji.

---

## Core Principles

### 1. Minimal Patch First

- Mudar só o necessário. Não refatorar código ao redor.
- Não criar abstração/helper/util pra uso único. Só extrair componente/função quando usado em 3+ lugares.
- Não limpar código não relacionado enquanto conserta um bug.

### 2. No Over-Engineering

- Sem abstração especulativa ("pode ser útil depois"). Sem design pattern sem o problema exigir.
- Três linhas parecidas > abstração prematura. Sem feature flag / shim de retrocompat — só muda o código.

### 3. No Hardcoding

- Nunca hardcodar IDs, slugs, magic numbers ou strings — usar constante/config/enum.
- Nunca hardcodar texto no JSX — usar `t('chave')` do i18n (`useT()`). Ver [i18n](#i18n).
- Nunca hardcodar cor/spacing/sombra — usar tokens do design system. Ver [Styling](#styling).
- Valores específicos de ambiente vêm de config, não inline.

### 4. Use What Already Exists

- **UI**: checar `src/renderer/src/components/ui/` (button, dialog, card, badge, ds-select, combo-select, context-menu, empty-state, etc.) e as pastas de domínio (`agents/`, `chat/`, `sources/`, `workspace/`, `settings/`, `layout/`…) ANTES de criar componente.
- **Ícones**: `lucide-react` (+ `brand-icons.tsx` / `ProviderIcon.tsx`). Não adicionar lib de ícone nova. **Sem emoji** — usar ícone.
- **Stores**: Zustand em `src/renderer/src/stores/`. Não usar React Context pra estado global.
- **Tipos + IPC**: tipos em `src/shared/types/`, canais em `src/shared/ipc-contract.ts`. Reusar canal existente antes de criar.
- **DB**: repositórios em `src/main/db/repositories/`. Lógica de dados vai no repo, não no handler IPC.

### 5. Clean Code

- Função faz uma coisa, nome diz o que faz. Sem dead code, bloco comentado ou `console.log` esquecido.
- Sem `any` no TS salvo inevitável — aí comentar o porquê (`// reason:`).
- **Não remover comentários existentes** — inline tipo `// hitbox`, `// Mock UI` existem por razão.

### 6. Arquivos novos em TypeScript

- Todo arquivo novo: `.ts` (utils/hooks/stores) ou `.tsx` (componentes). Não criar `.js`/`.jsx` novos.

---

## Styling

**Design System é fonte única de verdade. Antes de criar OU mudar qualquer UI, ler [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md)** (tabela completa de tokens + anti-padrões). Os tokens vivem no bloco `@theme` de `src/renderer/src/styles/global.css` (o Tailwind v4 gera as classes a partir dele).

- Toda cor/superfície/borda/texto vem de **token semântico**, NUNCA cor crua:
  - Superfícies: `bg-sidebar`, `bg-background`, `bg-surface`, `bg-surface-elevated`.
  - Bordas: `border-border`, `border-border-strong` (ou `border-white/[0.0x]` no padrão do app).
  - Texto: `text-text-primary`, `text-text-secondary`, `text-text-muted`, `text-text-faint`.
  - Accent: `text-accent` / `bg-accent` (cor principal) e `accent-purple|blue|green|yellow|red|orange`.
  - Status: tokens `--color-status-*` (backlog, todo, in-progress, in-review…).
- **Proibido**: `bg-white`, `bg-black`, `text-white`, `text-zinc-X`, `bg-[#hex]`, `style={{ color: '...' }}` pra cor estática. Exceção: valor **dinâmico** que não dá pra expressar em Tailwind (ex.: gradiente do avatar a partir de `workspace.color`).
- Se a cor/token que você precisa não existe, **adicionar token** no `@theme` de `global.css` — não inline valor arbitrário.
- **Tamanho de fonte/spacing arbitrário (`text-[12.5px]`, `px-[…]`) é OK** — o app usa essa convenção; seguir o padrão das linhas vizinhas, não inventar escala nova.

### Cor principal (accent) por workspace

- A cor accent é **por workspace** (`workspace.color`). Aplicada via `src/renderer/src/lib/accents.ts` (`applyWorkspaceAccent` seta `data-accent` no `<html>`, que remapeia `--color-accent`). Trocar de workspace troca a cor.
- Nunca hardcodar a cor accent em hex — usar `text-accent`/`bg-accent` ou `var(--color-accent)`. Pra tintar ícone dinamicamente: `style={{ color: 'var(--color-accent)' }}`.

### className

- **Sempre `cn()` de `src/renderer/src/lib/utils.ts`** pra className condicional/composta — nunca template literal (`` `class ${cond ? 'a' : 'b'}` ``) nem concatenação.
- Preferir sintaxe de objeto: `cn('base', { 'classe': condicao })`.

---

## i18n

- Hook `useT()` (de `src/renderer/src/i18n`). Locales em `src/renderer/src/i18n/locales/` — **`en` e `pt-BR`**.
- Ao criar string nova, adicionar a chave nos **dois** locales.
- Nunca hardcodar PT/EN no JSX. Fallback de erro: `t('<scope>.unknown_error')`, nunca string crua.
- Datas com locale dinâmico, não `'pt-BR'` fixo.

---

## Data & State

- **Server state**: TanStack Query (`useQuery`). Após mutação, `queryClient.invalidateQueries({ queryKey: [...] })` — não fazer merge manual de estado.
- **Client state**: Zustand. Selector com `useShallow` quando pegar múltiplos campos.
- Sem `useEffect + fetch` pra dados de servidor — usar Query. Sem `sleep`/polling — usar eventos/invalidate.

---

## DB / Migrations (Drizzle + SQLite)

- Schema declarado em `src/main/db/schema.ts`. Toda mudança de schema precisa de **migration nova** em `src/main/db/migrations.ts` (novo objeto no array `migrations` com `version` incremental — o runner aplica por `user_version`).
- **Nunca editar migration já existente** — sempre adicionar uma nova versão.
- Migrations idempotentes quando possível (`ADD COLUMN`, `CREATE INDEX IF NOT EXISTS`). Backfill de dados existentes na mesma migration quando a coluna nova precisa de valor.
- Acesso a dados via repositórios (`src/main/db/repositories/`), não query solta no handler.

---

## Naming

| Tipo            | Convenção           | Exemplo             |
| --------------- | ------------------- | ------------------- |
| Componente      | PascalCase          | `IssuesPage.tsx`    |
| Hook            | camelCase com `use` | `useIssueReadStore` |
| Store (zustand) | `xStore.ts`         | `workspaceStore.ts` |
| Repo            | `x.repo.ts`         | `issue.repo.ts`     |
| Util/Helper     | camelCase           | `accents.ts`        |
| Coluna DB       | snake_case          | `parent_issue_id`   |
| Canal IPC       | `dominio:acao`      | `issue:create-full` |

---

## What NOT to Do

- Não adicionar tratamento de erro pra cenário que não acontece na prática.
- Não criar componente wrapper pra uso único.
- Não adicionar dependência sem checar se já existe equivalente no projeto.
- Não adicionar ferramenta (Playwright/Sentry/Storybook/etc.) sem pedido explícito.
- Não usar emoji — usar ícone (`lucide-react`).
- Não hardcodar cor/string/ID — ver Core Principles #3.
