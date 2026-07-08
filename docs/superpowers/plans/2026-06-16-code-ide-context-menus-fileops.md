# IDE Fase 1 — Menus de contexto + operações de arquivo + add-to-chat

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Clique direito na aba e na árvore da IDE com gestão de arquivos (criar/renomear/excluir), copiar caminho, revelar no Finder/árvore e adicionar ao chat.

**Architecture:** 5 IPC novos no main (create-file/create-dir/rename/delete/reveal) com `resolveInsideSource`. No renderer: menu via `useContextMenu()`, edição inline na árvore, store novo `codeIdeStore` pra reveal+edição, ações novas no `codeTabsStore`.

**Tech Stack:** Electron, React 19, zustand, React Query, framer-motion já presentes. Sem dep nova.

**Convenções:** sem commit/git (regra do Luccas); sem testes (gate = typecheck+eslint+build); i18n pt-BR+en em `layout.codeIde.*`; `cn({})` object syntax; sem emoji.

---

## Task 1: Backend — 5 IPC de operação de arquivo

**Files:** Modify `src/shared/ipc-contract.ts`, `src/main/ipc/handlers/sources.ts`

- [ ] **Step 1: contrato** — após os canais `source:read-dir/read-file/write-file`, adicionar ao `IpcContract`:

```typescript
  'source:create-file': { request: { sourceId: string; relPath: string }; response: { ok: true } };
  'source:create-dir': { request: { sourceId: string; relPath: string }; response: { ok: true } };
  'source:rename': { request: { sourceId: string; relPath: string; newRelPath: string }; response: { ok: true } };
  'source:delete': { request: { sourceId: string; relPath: string }; response: { ok: true } };
  'source:reveal': { request: { sourceId: string; relPath: string }; response: { ok: true } };
```

E os 5 nomes na lista `IPC_CHANNELS` (após `'source:write-file',`).

- [ ] **Step 2: imports em sources.ts** — somar `mkdirSync, renameSync` ao import de `node:fs` e `dirname` ao de `node:path`. Importar `shell` de `electron` (conferir se já não está importado).

- [ ] **Step 3: handlers** dentro de `registerSourcesHandlers` (todos via `resolveInsideSource`):

```typescript
registerHandler('source:create-file', ({ sourceId, relPath }) => {
  const { abs } = resolveInsideSource(sourceId, relPath);
  if (existsSync(abs)) throw new Error('file-exists');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '', 'utf-8');
  return { ok: true as const };
});
registerHandler('source:create-dir', ({ sourceId, relPath }) => {
  const { abs } = resolveInsideSource(sourceId, relPath);
  if (existsSync(abs)) throw new Error('dir-exists');
  mkdirSync(abs, { recursive: true });
  return { ok: true as const };
});
registerHandler('source:rename', ({ sourceId, relPath, newRelPath }) => {
  const { abs: absFrom } = resolveInsideSource(sourceId, relPath);
  const { abs: absTo } = resolveInsideSource(sourceId, newRelPath);
  if (existsSync(absTo)) throw new Error('target-exists');
  mkdirSync(dirname(absTo), { recursive: true });
  renameSync(absFrom, absTo);
  return { ok: true as const };
});
registerHandler('source:delete', async ({ sourceId, relPath }) => {
  const { abs } = resolveInsideSource(sourceId, relPath);
  await shell.trashItem(abs);
  return { ok: true as const };
});
registerHandler('source:reveal', ({ sourceId, relPath }) => {
  const { abs } = resolveInsideSource(sourceId, relPath);
  shell.showItemInFolder(abs);
  return { ok: true as const };
});
```

- [ ] **Step 4:** `npm run typecheck` PASS. Não commitar.

---

## Task 2: i18n — chaves do code-ide

**Files:** Modify `src/renderer/src/i18n/locales/pt-BR/layout.json`, `.../en/layout.json`

- [ ] **Step 1:** dentro do objeto `codeIde` (já existe, tem emptyTitle etc), adicionar:

pt-BR:

```json
    "ctxOpen": "Abrir",
    "ctxNewFile": "Novo arquivo",
    "ctxNewFolder": "Nova pasta",
    "ctxRename": "Renomear",
    "ctxDelete": "Excluir",
    "ctxCopyPath": "Copiar caminho",
    "ctxCopyRelPath": "Copiar caminho relativo",
    "ctxRevealFinder": "Revelar no Finder",
    "ctxRevealTree": "Revelar na árvore",
    "ctxAddToChat": "Adicionar ao chat",
    "tabClose": "Fechar",
    "tabCloseOthers": "Fechar outras",
    "tabCloseRight": "Fechar à direita",
    "tabCloseSaved": "Fechar salvos",
    "tabCloseAll": "Fechar todas",
    "deleteConfirm": "Excluir \"{name}\"? Vai para a Lixeira.",
    "copiedPath": "Caminho copiado",
    "addedToChat": "Arquivo adicionado ao chat",
    "openChatFirst": "Abra um chat para adicionar o arquivo",
    "renameError": "Não foi possível renomear",
    "createError": "Não foi possível criar",
    "deleteError": "Não foi possível excluir",
    "revealError": "Não foi possível revelar o arquivo",
    "namePlaceholder": "nome"
```

en (mesmas chaves):

```json
    "ctxOpen": "Open",
    "ctxNewFile": "New file",
    "ctxNewFolder": "New folder",
    "ctxRename": "Rename",
    "ctxDelete": "Delete",
    "ctxCopyPath": "Copy path",
    "ctxCopyRelPath": "Copy relative path",
    "ctxRevealFinder": "Reveal in Finder",
    "ctxRevealTree": "Reveal in tree",
    "ctxAddToChat": "Add to chat",
    "tabClose": "Close",
    "tabCloseOthers": "Close others",
    "tabCloseRight": "Close to the right",
    "tabCloseSaved": "Close saved",
    "tabCloseAll": "Close all",
    "deleteConfirm": "Delete \"{name}\"? It will be moved to Trash.",
    "copiedPath": "Path copied",
    "addedToChat": "File added to chat",
    "openChatFirst": "Open a chat to add the file",
    "renameError": "Could not rename",
    "createError": "Could not create",
    "deleteError": "Could not delete",
    "revealError": "Could not reveal the file",
    "namePlaceholder": "name"
```

(o `t('layout.codeIde.deleteConfirm', { name })` — confirmar se o `t` do projeto suporta interpolação `{name}`; se não, montar a string no componente.)

- [ ] **Step 2:** `npm run typecheck` PASS (JSON válido). Não commitar.

---

## Task 3: codeTabsStore — ações de fechar + rename de aba

**Files:** Modify `src/renderer/src/stores/codeTabsStore.ts`

- [ ] **Step 1:** adicionar à interface e ao store:

```typescript
  closeOthers: (relPath: string) => void;
  closeToRight: (relPath: string) => void;
  closeSaved: () => void;
  closeAll: () => void;
  renameTab: (oldRelPath: string, newRelPath: string, newName: string) => void;
```

Implementações (dentro do `create`):

```typescript
  closeOthers: (relPath) =>
    set((s) => ({ tabs: s.tabs.filter((t) => t.relPath === relPath), activePath: relPath })),
  closeToRight: (relPath) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.relPath === relPath);
      if (idx < 0) return s;
      const tabs = s.tabs.slice(0, idx + 1);
      const activePath = tabs.some((t) => t.relPath === s.activePath)
        ? s.activePath
        : relPath;
      return { tabs, activePath };
    }),
  closeSaved: () =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.dirty);
      const activePath = tabs.some((t) => t.relPath === s.activePath)
        ? s.activePath
        : (tabs[tabs.length - 1]?.relPath ?? null);
      return { tabs, activePath };
    }),
  closeAll: () => set({ tabs: [], activePath: null }),
  renameTab: (oldRelPath, newRelPath, newName) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.relPath === oldRelPath ? { ...t, relPath: newRelPath, name: newName } : t,
      ),
      activePath: s.activePath === oldRelPath ? newRelPath : s.activePath,
    })),
```

- [ ] **Step 2:** `npm run typecheck` PASS. Não commitar.

---

## Task 4: codeIdeStore — reveal + edição inline

**Files:** Create `src/renderer/src/stores/codeIdeStore.ts`

- [ ] **Step 1:**

```typescript
import { create } from 'zustand';

export type PendingEdit =
  | { kind: 'rename'; targetRelPath: string }
  | { kind: 'new-file'; parentRelPath: string }
  | { kind: 'new-dir'; parentRelPath: string }
  | null;

interface CodeIdeState {
  /** Arquivo a revelar na árvore (auto-expande pais + scroll). */
  revealPath: string | null;
  /** Edição inline em curso (qual linha mostra input). */
  pendingEdit: PendingEdit;
  requestReveal: (relPath: string) => void;
  clearReveal: () => void;
  startRename: (targetRelPath: string) => void;
  startNewFile: (parentRelPath: string) => void;
  startNewDir: (parentRelPath: string) => void;
  clearEdit: () => void;
}

export const useCodeIdeStore = create<CodeIdeState>((set) => ({
  revealPath: null,
  pendingEdit: null,
  requestReveal: (relPath) => set({ revealPath: relPath }),
  clearReveal: () => set({ revealPath: null }),
  startRename: (targetRelPath) => set({ pendingEdit: { kind: 'rename', targetRelPath } }),
  startNewFile: (parentRelPath) => set({ pendingEdit: { kind: 'new-file', parentRelPath } }),
  startNewDir: (parentRelPath) => set({ pendingEdit: { kind: 'new-dir', parentRelPath } }),
  clearEdit: () => set({ pendingEdit: null }),
}));
```

- [ ] **Step 2:** `npm run typecheck` PASS. Não commitar.

---

## Task 5: addFileToChat helper

**Files:** Create `src/renderer/src/lib/addFileToChat.ts`

Objetivo: injetar `@relPath` no rascunho da sessão de chat ativa. O implementador DEVE ler `src/renderer/src/components/chat/ChatPrompt.tsx` e o store de draft (`grep -rn "setDraft\|useDraftStore\|draftStore" src/renderer/src`) pra confirmar: (a) como obter a sessão ativa, (b) a assinatura de `setDraft`. Esqueleto:

- [ ] **Step 1:**

```typescript
import { toast } from '@renderer/stores/toastStore';
// importar o(s) store(s) reais após confirmar a API (draftStore + sessão ativa)

/** Anexa `@relPath` ao rascunho do chat ativo. Toast i18n via t passado pelo caller. */
export function addFileToChat(relPath: string, t: (k: string) => string): void {
  // 1. obter activeSessionId do store de chat ativo (confirmar fonte)
  // 2. se não houver: toast.info(t('layout.codeIde.openChatFirst')); return;
  // 3. draft atual via draftStore.getState().drafts[sessionId] (confirmar shape)
  // 4. setDraft(sessionId, (draft ? draft + ' ' : '') + '@' + relPath)
  // 5. toast.success(t('layout.codeIde.addedToChat'))
}
```

> Implementador: completar com a API real. Se a "sessão ativa" não for trivialmente acessível fora do chat, usar a sessão mais recente do `useChatStore`; se não houver nenhuma, cair no toast `openChatFirst`. Reportar a decisão.

- [ ] **Step 2:** `npm run typecheck` PASS. Não commitar.

---

## Task 6: EditorTabs — menu de contexto

**Files:** Modify `src/renderer/src/components/code-ide/EditorTabs.tsx`, `src/renderer/src/pages/SourceCodePage.tsx`

- [ ] **Step 1: passar sourceRoot** — em `SourceCodePage`, passar `sourceRoot={source.path}` pro `<EditorTabs />`. Adicionar prop `sourceRoot: string` ao componente.

- [ ] **Step 2: context menu na aba** — usar `useContextMenu()` (`@renderer/components/ui/context-menu`; ler a API real do arquivo). No `<div>` de cada aba, `onContextMenu={(e) => openMenu(e, buildItems(tab))}`. Itens (i18n via `useT`):

```
Fechar            -> handleClose(tab.relPath, tab.dirty)
Fechar outras     -> closeOthers(tab.relPath)
Fechar à direita  -> closeToRight(tab.relPath)
Fechar salvos     -> closeSaved()
Fechar todas      -> closeAll()
--sep--
Copiar caminho        -> copy(sourceRoot + '/' + tab.relPath) + toast copiedPath
Copiar caminho rel.   -> copy(tab.relPath) + toast copiedPath
--sep--
Revelar no Finder -> window.orkestral['source:reveal']({sourceId, relPath}) (catch -> toast revealError)
Revelar na árvore -> useCodeIdeStore.getState().requestReveal(tab.relPath)
Adicionar ao chat -> addFileToChat(tab.relPath, t)
```

`copy` = `navigator.clipboard.writeText(x).catch(()=>undefined)`. `sourceId` precisa estar disponível — passar também como prop `sourceId` pro EditorTabs (de SourceCodePage). Manter o ícone material + dirty dot + botão fechar já existentes.

- [ ] **Step 3:** `npm run typecheck` + `npx eslint` no arquivo PASS. Não commitar.

---

## Task 7: FileTree — menu de contexto + edição inline + reveal

**Files:** Modify `src/renderer/src/components/code-ide/FileTree.tsx`, `src/renderer/src/pages/SourceCodePage.tsx`

`FileTree` recebe novas props de `SourceCodePage`: `sourceRoot: string`. Já tem `sourceId`. Usa `useQueryClient` pra invalidar; `useCodeIdeStore` pra pendingEdit/reveal; `useT`; `useContextMenu`.

- [ ] **Step 1: context menu por nó** — `onContextMenu` no botão de arquivo e no de pasta. Itens conforme tipo (i18n):

Arquivo: Abrir / —sep— / Copiar caminho / Copiar caminho relativo / Revelar no Finder / Revelar na árvore / Adicionar ao chat / —sep— / Renomear (`startRename(relPath)`) / Excluir (confirm `deleteConfirm` → `source:delete` → invalidar dir-pai → fechar aba se aberta via `closeTab` do codeTabsStore).

Pasta: Novo arquivo (`startNewFile(relPath)` + garante `open`) / Nova pasta (`startNewDir(relPath)`) / —sep— / Copiar caminho / Copiar caminho relativo / Revelar no Finder / —sep— / Renomear / Excluir.

Header da raiz (no `FileTree`, área do nome da source em `SourceCodePage` OU no nó raiz): Novo arquivo / Nova pasta com `parentRelPath = ''`. (Implementador: expor um menu no header da aside de `SourceCodePage` chamando `startNewFile('')`/`startNewDir('')`.)

- [ ] **Step 2: edição inline** — `FileTree` lê `pendingEdit`. Helper de input:

```tsx
function InlineNameInput({
  initial,
  onSubmit,
  onCancel,
  depth,
}: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  depth: number;
}) {
  const [val, setVal] = useState(initial);
  return (
    <input
      autoFocus
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const name = val.trim();
          if (name && !name.includes('/')) onSubmit(name);
        } else if (e.key === 'Escape') onCancel();
      }}
      onBlur={onCancel}
      placeholder={/* t('layout.codeIde.namePlaceholder') */ ''}
      className="h-6 w-full rounded border border-accent-purple/40 bg-surface-1 px-1 text-[12.5px] text-text-primary outline-none"
      style={{ marginLeft: depth * 12 + 4 }}
    />
  );
}
```

- `rename`: na linha cujo `relPath === pendingEdit.targetRelPath`, renderizar o input no lugar do nome, `initial = basename`. `onSubmit(name)`: `newRelPath = parentOf(relPath) + name`; chamar `source:rename`; em sucesso → `renameTab(old, newRelPath, name)` (codeTabsStore), invalidar dir-pai, `clearEdit()`. Erro → toast `renameError`, mantém input.
- `new-file`/`new-dir`: dentro da pasta `parentRelPath` (forçar `open`), renderizar uma linha-input extra. `onSubmit(name)`: `relPath = parentRelPath ? parentRelPath + '/' + name : name`; chamar `source:create-file`/`create-dir`; sucesso → invalidar `['source-dir', sourceId, parentRelPath]`, `clearEdit()`; pra new-file também `onOpenFile(relPath, name)`.

`parentOf(rel)` = `rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''`. `basename` idem com slice depois da última `/`.

- [ ] **Step 3: reveal na árvore** — `DirNode` força `open` quando é ancestral de `revealPath`:

```tsx
const reveal = useCodeIdeStore((s) => s.revealPath);
const isAncestorOfReveal =
  !!reveal && !isRoot && (reveal === relPath || reveal.startsWith(relPath + '/'));
const [open, setOpen] = useState(isRoot);
useEffect(() => {
  if (isAncestorOfReveal) setOpen(true);
}, [isAncestorOfReveal]);
```

No botão do arquivo alvo: `ref` + efeito que faz `scrollIntoView({ block: 'nearest' })` e um destaque temporário quando `relPath === reveal`, depois `clearReveal()`:

```tsx
const fileRef = useRef<HTMLButtonElement>(null);
useEffect(() => {
  if (reveal === e.relPath) {
    fileRef.current?.scrollIntoView({ block: 'nearest' });
    const id = setTimeout(() => clearReveal(), 1200);
    return () => clearTimeout(id);
  }
}, [reveal, e.relPath]);
```

(destaque: classe `cn({ 'ring-1 ring-accent-purple/50': reveal === e.relPath })`.)

- [ ] **Step 4:** invalidações usam `useQueryClient().invalidateQueries({ queryKey: ['source-dir', sourceId, parentRelPath] })`.

- [ ] **Step 5:** `npm run typecheck` + `npx eslint` PASS. Não commitar.

---

## Task 8: Wiring final em SourceCodePage

**Files:** Modify `src/renderer/src/pages/SourceCodePage.tsx`

- [ ] **Step 1:** passar `sourceRoot={source.path}` e `sourceId` pra `EditorTabs` e `FileTree` (FileTree já tem sourceId). Adicionar menu de contexto / botões "Novo arquivo / Nova pasta" no header da aside (o `<div>` com `source.label`) chamando `useCodeIdeStore().startNewFile('')` / `startNewDir('')`. Garantir que após `source:delete` de um arquivo aberto, a aba fecha (`useCodeTabsStore.getState().closeTab(relPath)`).

- [ ] **Step 2:** `npm run typecheck` + `npx eslint` PASS. Não commitar.

---

## Task 9: Validação final

- [ ] **Step 1:** `npm run typecheck` limpo.
- [ ] **Step 2:** `npx eslint` nos arquivos tocados — limpo.
- [ ] **Step 3:** `npx electron-vite build` — sucesso (pega erro de glob/import).
- [ ] **Step 4:** `npx prettier --write` nos arquivos tocados.

---

## Self-review (cobertura do spec)

- 5 IPC (create-file/create-dir/rename/delete/reveal) → Task 1. ✓
- Excluir → Lixeira (`shell.trashItem`) → Task 1. ✓
- Menu da aba (close variants, copy path, reveal Finder/árvore, add chat) → Tasks 3,6. ✓
- Menu da árvore (new file/folder, rename, delete, copy path, reveal, add chat) → Task 7. ✓
- Edição inline (rename/new-file/new-dir) → Task 7. ✓
- Revelar na árvore (auto-expand + scroll) → Tasks 4,7. ✓
- Copiar caminho abs/rel (sourceRoot) → Tasks 6,7,8. ✓
- Add to chat (@relPath no draft) → Tasks 5,6,7. ✓
- i18n pt-BR+en → Task 2. ✓
- Segurança `resolveInsideSource` em todos IPC → Task 1. ✓
- Revalidação dir-pai pós-mutação → Tasks 7,8. ✓
