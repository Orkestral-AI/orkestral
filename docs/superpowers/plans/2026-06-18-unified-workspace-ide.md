# Unified Workspace IDE — Implementation Plan

> **Execução:** inline (executing-plans). SEM TDD, SEM testes, SEM commit (regra do projeto: orkestral não tem test runner; gate = `npm run typecheck` + `npx eslint`). Commit é o Luccas que faz.

**Goal:** Mover a árvore de arquivos pra dentro da coluna lateral "Fontes" (sources = raízes), deixar a área principal como IDE puro (Código/Git/Preview + editor + terminal), e seguir o source do arquivo aberto pra Git/Preview/Terminal. Configurações/Analisar viram ação por source-raiz.

**Architecture:** Stores já são globais (`codeTabsStore.active = {sourceId, relPath}`, `codeIdeStore`), então a árvore na sidebar dirige o editor na página sem prop drilling. "Source focado" = `codeTabsStore.active?.sourceId ?? primary`. Rota passa de `/sources/:sourceId` (página por source) → `/sources` (workspace único). `SourceDetailPage` vira `WorkspaceIdePage` sem header por-source.

**Tech:** React + react-router + zustand + tanstack-query + Electron. i18n next-intl-like (`useT`, `layout.json`/`workspace.json`).

---

## File Structure

- **Modify** `src/renderer/src/components/layout/Sidebar.tsx` — `SidebarSourcesSection` passa a renderizar a árvore unificada (tabs Files/Search + multi-source tree + Add source). Rail "sources" navega pra `/sources`.
- **Create** `src/renderer/src/components/code-ide/WorkspaceTree.tsx` — painel da árvore p/ a sidebar: tabs [Files][Search], lista de sources como raízes colapsáveis (reusa `FileTree`), source-raiz com menu (Configurações/Analisar), `+ Adicionar source`.
- **Create** `src/renderer/src/components/code-ide/SourceConfigDialog.tsx` — modal por sourceId (extrai o overlay de config do `SourceDetailPage`: label/role/primary/delete).
- **Create** `src/renderer/src/stores/workspaceIdeStore.ts` — estado leve do workspace: `configSourceId` (abre o SourceConfigDialog), `focusedSourceId` derivado.
- **Rewrite** `src/renderer/src/pages/SourceDetailPage.tsx` → `WorkspaceIdePage` (mantém arquivo, troca conteúdo): sem header por-source; tabs Código/Git/Preview + Chat; editor/preview/git seguem o source focado; terminal vira painel inferior.
- **Modify** `src/renderer/src/router.tsx` — add `/sources` → `WorkspaceIdePage`; `/sources/:sourceId` redireciona pra `/sources` (set focused source).
- **Modify** `src/renderer/src/components/code-ide/SourceCodePage.tsx` — `SourceCodeInner` deixa de renderizar a árvore (só editor + tabs de arquivo); a árvore foi pra sidebar.
- **Modify** `messages/pt-BR/layout.json` + `messages/en/layout.json` — keys novas (`workspaceIde.*`).

---

## Task 1 — Store do workspace IDE

**Files:** Create `src/renderer/src/stores/workspaceIdeStore.ts`

- [ ] Criar store:

```ts
import { create } from 'zustand';

interface WorkspaceIdeState {
  /** sourceId cujo dialog de Configurações está aberto. null = fechado. */
  configSourceId: string | null;
  openConfig: (sourceId: string) => void;
  closeConfig: () => void;
}

export const useWorkspaceIdeStore = create<WorkspaceIdeState>((set) => ({
  configSourceId: null,
  openConfig: (sourceId) => set({ configSourceId: sourceId }),
  closeConfig: () => set({ configSourceId: null }),
}));
```

**Nota:** "source focado" NÃO mora aqui — deriva de `codeTabsStore.active?.sourceId`. Fallback = source primária da lista.

- [ ] `npm run typecheck`.

---

## Task 2 — SourceConfigDialog (extrai overlay de config)

**Files:** Create `src/renderer/src/components/code-ide/SourceConfigDialog.tsx`

Move o conteúdo do bloco `showConfig` do `SourceDetailPage` (label/role inputs, save, set-primary, delete) pra um modal controlado por `useWorkspaceIdeStore.configSourceId`. Reusa `Section`/`Field`/`ActionRow` (exportar de um util ou recriar local). Carrega o source via `['source-by-id', sourceId]` (mesma query de hoje). Usa o componente de Dialog do design system (procurar `components/ui/dialog`).

- [ ] Criar o dialog; props: nenhuma (lê `configSourceId` do store, fecha via `closeConfig`).
- [ ] Mutations `source:update` / `source:set-primary` / `source:delete` (copiar de SourceDetailPage). Após delete, fechar dialog (não navega — workspace continua).
- [ ] `npm run typecheck`.

---

## Task 3 — WorkspaceTree (árvore na sidebar)

**Files:** Create `src/renderer/src/components/code-ide/WorkspaceTree.tsx`

Painel pra caber nos ~248px da sidebar:

- Topo: tabs `[Files][Search]` (reusa `useCodeIdeStore.view`/`setView`). Terminal sai daqui (vai pro painel inferior do IDE).
- View `files`: pra cada source local (`sources.filter(s => !!s.path)`), um header colapsável (label + git-count badge + botão de menu) → `<FileTree sourceId sourceRoot ... />`. Menu (hover/right-click no source-raiz): **Configurações** (`openConfig(sourceId)`), **Analisar** (chama `AnalyzeButton` logic / `kb:request-source-analysis`).
- View `search`: `<SearchPanel sources={localSources}/>` (cross-source, já existe).
- Rodapé: `+ Adicionar source` (`useUIStore.getState().openAddSource()`).
- Abrir arquivo: `useCodeTabsStore.getState().openTab(sourceId, relPath, name)` + `setActive`.

- [ ] Implementar. Reaproveitar o componente `SourceSection` que já existia em `SourceCodePage.tsx` (mover pra cá).
- [ ] `npm run typecheck` + `npx eslint` no arquivo.

---

## Task 4 — Sidebar usa a WorkspaceTree

**Files:** Modify `src/renderer/src/components/layout/Sidebar.tsx`

- [ ] `SidebarSourcesSection` (linha ~797) passa a renderizar `<WorkspaceTree workspaceId={workspaceId} />` no lugar da lista `SidebarSourceRow`. Manter org switcher acima (fora dessa função).
- [ ] Rail group "sources": ao ativar, navegar `/sources` (não mais depender de clicar um source). Conferir como `activeGroup` vira navegação.
- [ ] `npm run typecheck`.

---

## Task 5 — WorkspaceIdePage (reescreve SourceDetailPage)

**Files:** Rewrite `src/renderer/src/pages/SourceDetailPage.tsx`

- [ ] Tirar header por-source (folder icon, label, Primary, role, Pasta local) e os botões Configurações/Analisar do header.
- [ ] `focusedSourceId = useCodeTabsStore(s => s.active?.sourceId) ?? primarySource.id`. Carregar lista de sources (`['sources', workspaceId]`); `focusedSource = sources.find(id === focusedSourceId)`.
- [ ] Header novo (enxuto): tabs Código/Git/Preview (já existe, manter Tooltip + icon-only inativo) + botão Chat. Badge git = do focusedSource.
- [ ] Body: `SourceCodeInner` (editor, sem árvore) | `PreviewPanel sourceId={focusedSourceId}` | `CodeChangesInner source={focusedSource}` — todos seguem focusedSource.
- [ ] Terminal: painel inferior toggável (reusa `useCodeIdeStore.terminalOpen/toggleTerminal`), `TerminalPanel sourceId={focusedSourceId}`. Mover o `>_` toggle pro header novo.
- [ ] Manter os effects always-on (onTerminalUrlDetected/onTerminalData/onTerminalExit/preview openRequest) mas usar `focusedSourceId` no lugar de `sourceId` do param.
- [ ] Render `<SourceConfigDialog/>` (global) + `<IdeChatDrawer sourceId={focusedSourceId}/>`.
- [ ] Renomear export `SourceDetailPage` → `WorkspaceIdePage` (ajustar import no router).
- [ ] `npm run typecheck` + `npx eslint`.

---

## Task 6 — SourceCodeInner sem árvore

**Files:** Modify `src/renderer/src/components/code-ide/SourceCodePage.tsx`

- [ ] `SourceCodeInner` deixa de renderizar `SourceSection`/árvore/SearchPanel (foi pra WorkspaceTree). Fica só: barra de tabs de arquivo abertos + `CodeEditor` (do active tab) + placeholder "Nenhum arquivo aberto". `active = useCodeTabsStore(s => s.active)`; renderiza `CodeEditor sourceId={active.sourceId} relPath={active.relPath}`.
- [ ] `npm run typecheck`.

---

## Task 7 — Router

**Files:** Modify `src/renderer/src/router.tsx`

- [ ] `<Route path="/sources" element={<WorkspaceIdePage/>} />`.
- [ ] `<Route path="/sources/:sourceId" element={<RedirectToWorkspace/>} />` — componente que lê `:sourceId`, abre/foca esse source (via openTab do primeiro arquivo? não — só navega `/sources`; o source vira focado quando o user clica), e `<Navigate to="/sources" replace/>`. Mínimo: redirect simples pra `/sources`.
- [ ] Import `WorkspaceIdePage` (era `SourceDetailPage`).
- [ ] `npm run typecheck`.

---

## Task 8 — i18n + gate final

**Files:** Modify `messages/pt-BR/layout.json`, `messages/en/layout.json`

- [ ] Adicionar keys usadas (ex.: `layout.codeIde.workspaceTree.*`, menu Configurações/Analisar se faltarem) nos DOIS locales, espelhadas.
- [ ] `npm run typecheck` (node + web) + `npx eslint` nos arquivos tocados. Tudo limpo.

---

## Self-Review checklist

- Cobertura: tree→sidebar (T3/T4), IDE puro (T5/T6), config/analisar por source-raiz (T2/T3), git/preview/terminal seguem focado (T5), rota (T7). OK.
- Tipos: `focusedSourceId: string`, `WorkspaceTree({workspaceId})`, `useWorkspaceIdeStore.openConfig(sourceId)`, `SourceConfigDialog` sem props. Consistentes.
- Risco maior: rota + sidebar chrome. Testar core (tree na sidebar + IDE sem header) antes de polir terminal/menu.
