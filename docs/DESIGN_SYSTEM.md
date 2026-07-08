# Orkestral — Design System

Fonte única de verdade pra cor, tipografia, raio, superfície e componentes. **Antes de criar OU mudar qualquer UI, ler este doc.** Se um token não existe, **adicionar token** — nunca inline valor arbitrário de cor.

Os tokens vivem no bloco `@theme` de [`src/renderer/src/styles/global.css`](../src/renderer/src/styles/global.css). O Tailwind v4 gera as classes automaticamente: `--color-text-primary` vira `text-text-primary` / `bg-text-primary`, `--color-surface` vira `bg-surface`, etc.

---

## 1. Cores

### Superfícies (do mais fundo ao mais elevado)

| Token                      | Classe                | Uso                                                     |
| -------------------------- | --------------------- | ------------------------------------------------------- |
| `--color-sidebar`          | `bg-sidebar`          | Sidebar + faixa externa do card inset (fundo do `body`) |
| `--color-background`       | `bg-background`       | Card de conteúdo / área principal                       |
| `--color-surface`          | `bg-surface`          | Popover, dialog, card menor                             |
| `--color-surface-elevated` | `bg-surface-elevated` | Inputs, badges, botões secundários                      |
| `--color-dialog`           | `bg-dialog`           | Fundo do modal/dialog                                   |

### Bordas

| Token                                    | Classe                 | Uso                                                         |
| ---------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| `--color-border`                         | `border-border`        | Borda padrão                                                |
| `--color-border-strong`                  | `border-border-strong` | Borda de mais contraste                                     |
| `--color-hairline` / `-soft` / `-strong` | `border-hairline*`     | Divisórias sutis (tematizáveis; dark = `white/[0.04–0.08]`) |

### Texto (hierarquia)

| Token                    | Classe                | Uso                                       |
| ------------------------ | --------------------- | ----------------------------------------- |
| `--color-text-primary`   | `text-text-primary`   | Texto principal                           |
| `--color-text-secondary` | `text-text-secondary` | Secundário / labels                       |
| `--color-text-muted`     | `text-text-muted`     | Apoio                                     |
| `--color-text-faint`     | `text-text-faint`     | Metadados, placeholders, ícones discretos |

### Accent (cor principal — **por workspace**)

| Token                                               | Classe                                      | Uso                                                                          |
| --------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| `--color-accent`                                    | `bg-accent` / `text-accent`                 | Tom **sólido** da marca: badges/pills/botões de fundo cheio com texto branco |
| `--color-accent-purple`                             | `text-accent-purple`, `bg-accent-purple/10` | Tom **claro**: ícones, tints sutis, dots                                     |
| `--color-accent-{blue\|green\|yellow\|red\|orange}` | idem                                        | Hues fixos (status, categorias)                                              |

> A cor accent é **por workspace** (`workspace.color`). Aplicada em runtime via [`src/renderer/src/lib/accents.ts`](../src/renderer/src/lib/accents.ts) (`applyWorkspaceAccent` seta `data-accent` no `<html>`, remapeando `--color-accent` + `--color-accent-purple`). Trocar de workspace troca a cor. **Nunca hardcodar a cor accent em hex** — usar `text-accent`/`bg-accent` ou `var(--color-accent)`. Pra tintar ícone dinâmico: `style={{ color: 'var(--color-accent)' }}`.

### Status de issue

`--color-status-{backlog|todo|in-progress|in-review|blocked|done|cancelled}` → `text-status-*` / `bg-status-*`.

### Prioridade

`--color-priority-{critical|high|medium|low}` → `text-priority-*`.

### Inputs / switch (tematizáveis)

`--color-input-bg`, `--color-input-border`, `--color-input-border-focus`, `--color-switch-off`. Usar nos campos pra funcionarem em dark **e** light.

---

## 2. Temas

- **Dark é o default** (sem atributo no `<html>`).
- **Light**: `<html data-theme="light">` sobrescreve as vars do `@theme`. Por isso **usar tokens, não cor crua** — cor crua não acompanha o tema.
- **Accent**: `<html data-accent="blue|green|yellow|orange|red">` (ou `purple` = default). Pode ser escopado em subárvore (ex.: wizard de workspace pré-visualiza a cor escolhida só dentro do modal).
- **Tamanho de fonte**: `html[data-font-size="sm|lg"]`. **Densidade**: `html[data-density="compact"]` (`--density-gap`).

---

## 3. Tipografia

- **Sans**: Inter (`--font-sans`, classe `font-sans`). **Mono**: JetBrains Mono (`--font-mono`, classe `font-mono`) — para `code`/`pre`/`kbd` e IDs tipo `EZC-4`.
- Base do `body` = 14px, `line-height: 1.5`.
- Escala Tailwind (`text-xs`, `text-sm`, `text-base`…) é o default.
- **Tamanho em px arbitrário (`text-[12.5px]`, `text-[10.5px]`) é permitido** — o app usa essa convenção densa pervasivamente. Seguir o tamanho das linhas vizinhas; não inventar escala nova nem "corrigir" pra `text-sm` sem motivo.

---

## 4. Raio

`--radius-sm` (6px), `--radius-md` (8px), `--radius-lg` (12px), `--radius-xl` (16px) → `rounded-sm/md/lg/xl`. Default de botões/cards = `rounded-md`.

---

## 5. Componentes (primitives em `src/renderer/src/components/ui/`)

Sempre checar aqui (e nas pastas de domínio: `agents/`, `chat/`, `sources/`, `workspace/`, `settings/`, `layout/`…) **antes de criar componente novo ou hardcodar `<div>`/`<button>` cru**.

Disponíveis: `button`, `dialog`, `card`, `badge`, `ds-select`, `combo-select`, `context-menu`, `empty-state`, `attachments`, `Toaster`, entre outros.

### Button (`button.tsx`)

- **variant**: `primary` (fundo `text-primary` sobre `background` — alto contraste), `secondary` (default — `surface-elevated` + borda), `ghost` (transparente, hover `surface-elevated`), `destructive` (`accent-red/15`), `outline`.
- **size**: `sm` (h-7), `md` (default, h-9), `lg` (h-10), `icon` (8×8), `icon-sm` (7×7).
- Ícone via children do lucide-react. `asChild` pra renderizar como `<a>`/`Link`.

---

## 6. Ícones

- **`lucide-react`** (+ `brand-icons.tsx` / `ProviderIcon.tsx` pra logos de provider). Não adicionar lib de ícone nova.
- **Sem emoji em UI** — sempre ícone.

---

## 7. className: sempre `cn()`

`cn()` de [`src/renderer/src/lib/utils.ts`](../src/renderer/src/lib/utils.ts) (clsx + tailwind-merge).

```tsx
// Preferido — objeto pra condicional
cn('base', { 'text-accent': isActive, 'opacity-40': disabled })
// Evitar
`base ${isActive ? 'text-accent' : ''}`; // template literal
'base ' + (isActive && 'text-accent'); // concat
```

---

## 8. Utilitários globais

- `.thin-scrollbar` — scrollbar fininha (listas estreitas). `.no-scrollbar` — esconde mantendo scroll.
- `.window-drag` / `.window-no-drag` — região de arrasto da janela (traffic lights macOS).
- `.animate-pulse-dot` — pulso de indicador live. `.ai-shimmer` — texto "pensando".

---

## 9. Anti-padrões (NÃO fazer)

| ❌ Errado                                                         | ✅ Certo                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `bg-white`, `bg-black`, `text-white` (estático)                   | `bg-surface`, `bg-background`, `text-text-primary`            |
| `text-zinc-400`, `text-gray-500`                                  | `text-text-secondary` / `text-text-muted` / `text-text-faint` |
| `bg-[#6d28d9]`, `text-[#a78bfa]`                                  | `bg-accent`, `text-accent-purple`                             |
| `style={{ color: '#a78bfa' }}` (cor estática)                     | classe `text-accent-purple`                                   |
| `border-[#24262a]`                                                | `border-border`                                               |
| `<div className="rounded-full bg-primary px-4 py-2">` (botão cru) | `<Button variant="…">`                                        |
| Emoji em UI                                                       | ícone `lucide-react`                                          |
| `` `cls ${cond ? 'a' : 'b'}` ``                                   | `cn('cls', { a: cond, b: !cond })`                            |
| Inventar cor que não tem token                                    | adicionar token no `@theme` de `global.css`                   |

---

## 10. Exceções legítimas

- **Cor dinâmica** que não dá pra expressar em token: gradiente do avatar a partir de `workspace.color`, tinta de ícone via `var(--color-accent)`. OK usar `style={{}}` quando o valor é **dinâmico/runtime**.
- **Syntax highlighting**: classes `.hl-*` (paleta One Dark fixa no CodeBlock).
- **Mock de UI externa** (preview Messenger/Instagram/WhatsApp): cor crua aceitável pq replica app de terceiro — marcar com `// Mock <plataforma> UI — não usar design system`.
- **Overlays `white/[0.0x]`**: o padrão atual da chrome usa `bg-white/[0.02]`, `border-white/[0.06]` etc. (equivalentes byte-a-byte aos tokens `surface-*`/`hairline-*`). Manter consistência com o arquivo que você está editando.
