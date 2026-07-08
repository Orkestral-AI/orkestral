# IDE embutida — Fase 1: menus de contexto + operações de arquivo + add-to-chat

**Data:** 2026-06-16
**Status:** aprovado (aguardando review do spec)
**Contexto:** evolução da IDE embutida por source (ver `2026-06-14-embedded-code-ide-design.md`).

## Objetivo

Aproximar a IDE do VSCode com gestão de arquivos por menu de contexto (clique direito)
na aba aberta e na árvore, mais operações de arquivo (criar/renomear/excluir), copiar
caminho, revelar no Finder/na árvore, e uma integração Orkestral: adicionar arquivo ao chat.

Fase 2 (separada): header Arquivos/Busca + busca de conteúdo com replace.

## Fora de escopo (Fase 1)

- Busca de conteúdo / header de views (é a Fase 2).
- Split de editor, multi-janela, git (diff/history/timeline/remote), LSP (find references),
  pin/preview, terminal integrado, share — descartados (ver triagem no chat de design).
- Cortar/colar arquivos (cut/copy/paste de arquivo na árvore) — adiado.

## Decisões

| Tema                                 | Decisão                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| Componente de menu                   | Reusar `useContextMenu()` (`src/renderer/src/components/ui/context-menu.tsx`)    |
| Excluir                              | `shell.trashItem` (Lixeira, recuperável)                                         |
| Renomear / Novo arquivo / Nova pasta | Edição **inline** na linha da árvore (input no lugar do nome), sem `prompt()`    |
| Copiar caminho                       | absoluto = `source.path` + `/` + relPath; relativo = relPath                     |
| Revelar na árvore                    | store `revealPath`; `FileTree` auto-expande pastas-pai e dá scroll               |
| Add to chat                          | injeta `@relPath` no rascunho da sessão ativa (`draftStore`); toast              |
| Revalidação                          | após criar/renomear/excluir, invalidar `['source-dir', sourceId, parentRelPath]` |
| i18n                                 | pt-BR + en, namespace `layout.codeIde.*`                                         |
| Segurança                            | todos os IPC novos passam por `resolveInsideSource` (lexical + realpath symlink) |

## Backend (Electron main)

Arquivo: `src/main/ipc/handlers/sources.ts`. Contrato: `src/shared/ipc-contract.ts`
(adicionar os 5 canais ao `IpcContract` E à lista `IPC_CHANNELS`). Reusa
`resolveInsideSource(sourceId, relPath)` já existente.

- **`source:create-file`** — req `{ sourceId, relPath }`. Resolve; se `existsSync(abs)` →
  throw `file-exists`. Garante o diretório-pai (`mkdirSync(dirname(abs), {recursive:true})`
  dentro da source). `writeFileSync(abs, '')`. Resp `{ ok: true }`.
- **`source:create-dir`** — req `{ sourceId, relPath }`. Resolve; se existe → throw
  `dir-exists`. `mkdirSync(abs, { recursive: true })`. Resp `{ ok: true }`.
- **`source:rename`** — req `{ sourceId, relPath, newRelPath }`. Resolve AMBOS (origem e
  destino) dentro da source. Se destino `existsSync` → throw `target-exists`. Garante
  pai do destino. `renameSync(absFrom, absTo)`. Resp `{ ok: true }`.
- **`source:delete`** — req `{ sourceId, relPath }`. Resolve. `await shell.trashItem(abs)`
  (handler async). Resp `{ ok: true }`.
- **`source:reveal`** — req `{ sourceId, relPath }`. Resolve. `shell.showItemInFolder(abs)`.
  Resp `{ ok: true }`. (Versão escopada do `shell:reveal` existente, sem expor path absoluto
  ao renderer.)

`shell` e `trashItem` vêm de `electron`. Importar `mkdirSync, renameSync` (fs),
`dirname` (path) — somar aos imports já presentes.

## Renderer

### Store — `codeTabsStore.ts` (ações novas)

- `closeOthers(relPath)` — mantém só essa aba (ativa nela).
- `closeToRight(relPath)` — fecha as abas após o índice dessa.
- `closeSaved()` — fecha todas as abas com `dirty === false`.
- `closeAll()` — = `reset()`.

Fechamento de aba suja: o menu chama uma função do componente que confirma via
`window.confirm` por aba suja antes de remover (reusa a lógica de `handleClose`),
exceto `closeAll`/`closeSaved` que já respeitam o estado.

### Store novo — `codeIdeStore.ts` (UI da árvore)

Pequeno zustand pra coordenar árvore + reveal + edição inline:

- `revealPath: string | null` + `requestReveal(relPath)` / `clearReveal()`.
- `pendingEdit: { kind: 'rename' | 'new-file' | 'new-dir'; parentRelPath: string; targetRelPath?: string } | null`
  - setters. Dirige a edição inline (qual linha mostra input).

(Alternativa considerada: manter no `SourceCodePage` via props/context. Store é mais
limpo porque tanto o menu de contexto quanto o `FileTree` precisam disparar/observar.)

### Caminho da source

`SourceCodePage` já carrega `source` (tem `path`). Passa `sourceRoot={source.path}` pro
`FileTree` e pro `EditorTabs` (via prop) pra montar caminho absoluto no "copiar caminho".

### Util — `copyToClipboard`

Inline `navigator.clipboard.writeText(text).catch(()=>undefined)` + toast (padrão do app,
ver `CodeChangesPage`). Pequeno helper local ou inline nos handlers.

### Menu da aba — `EditorTabs.tsx`

`onContextMenu` na aba → `useContextMenu().open(e, items)`. Itens (todos i18n):
Fechar / Fechar outras / Fechar à direita / Fechar salvos / Fechar todas / —sep— /
Copiar caminho / Copiar caminho relativo / —sep— / Revelar no Finder (`source:reveal`) /
Revelar na árvore (`requestReveal(relPath)`) / Adicionar ao chat.
Copy path usa `sourceRoot`.

### Menu da árvore — `FileTree.tsx`

`onContextMenu` em cada nó (arquivo e pasta) → itens conforme tipo:

- **Arquivo:** Abrir / —sep— / Copiar caminho / Copiar caminho relativo / Revelar no
  Finder / Revelar na árvore / Adicionar ao chat / —sep— / Renomear / Excluir.
- **Pasta:** Novo arquivo / Nova pasta / —sep— / Copiar caminho / Copiar caminho relativo /
  Revelar no Finder / —sep— / Renomear / Excluir.
- **Raiz (header da source):** Novo arquivo / Nova pasta (no relPath '').

### Edição inline

`FileTree` lê `pendingEdit` do `codeIdeStore`:

- `rename`: na linha do `targetRelPath`, troca o label por um `<input>` com o nome atual
  selecionado (sem a extensão? não — nome inteiro, simples). Enter confirma → `source:rename`
  pra `parentRelPath + '/' + novoNome`; Esc cancela. Em sucesso: invalida o dir-pai, limpa
  `pendingEdit`, e se o arquivo renomeado estava aberto, atualiza a aba (relPath/name).
- `new-file` / `new-dir`: renderiza uma linha de input temporária dentro da pasta
  `parentRelPath` (expandindo-a se fechada). Enter → `source:create-file`/`create-dir`;
  invalida dir-pai; pra new-file abre a aba do arquivo criado.
- Validação de nome: não vazio, sem `/`, trim. Erro do IPC (já existe etc) → toast i18n,
  mantém o input aberto.

### Revelar na árvore

`FileTree` observa `revealPath`. Cada `DirNode` cuja `relPath` é ancestral de `revealPath`
(`revealPath === rel || revealPath.startsWith(rel + '/')`) força `open = true` (auto-expand).
O nó-arquivo alvo recebe `ref` e faz `scrollIntoView({ block: 'nearest' })` + destaque
temporário. Depois de revelar, `clearReveal()`.

### Add to chat

Helper `addFileToChat(relPath)`:

- Pega a sessão ativa do chat. Fonte: `useChatStore`/`draftStore` — usar a sessão atualmente
  aberta (mesma usada pelo `ChatPrompt`). Append `@relPath` no draft via
  `draftStore.setDraft(sessionId, (draft ?? '') + (draft ? ' ' : '') + '@' + relPath)`.
- Se não houver sessão ativa: toast i18n "Abra um chat para adicionar o arquivo".
- Toast de sucesso i18n.
  (Implementador deve confirmar a API real de sessão ativa + draftStore ao implementar; o
  shape exato é `setDraft(sessionId, text)` — ver `ChatPrompt.tsx`.)

## Fluxos

- **Criar arquivo:** menu pasta → Novo arquivo → input inline → Enter → `source:create-file`
  → invalida `['source-dir', sourceId, parentRel]` → abre aba.
- **Renomear:** menu → Renomear → input inline → Enter → `source:rename` → invalida pai →
  atualiza aba aberta se afetada.
- **Excluir:** menu → Excluir → confirm i18n → `source:delete` (Lixeira) → invalida pai →
  fecha aba se o arquivo estava aberto.
- **Copiar caminho / Revelar / Add to chat:** ação direta, com toast.

## Erros

- IPC throw (existe, fora da source, falha de fs) → toast i18n de erro; input inline
  permanece aberto pra corrigir.
- `shell.trashItem` falha → toast i18n; não fecha a aba.
- Sessão de chat ausente no add-to-chat → toast informativo.

## Validação

Sem testes (padrão Orkestral). Gate: `npm run typecheck` + `npx eslint` nos arquivos +
`npx electron-vite build`. Verificação manual: criar/renomear/excluir arquivo e pasta,
copiar caminho (abs e rel), revelar no Finder, revelar na árvore (arquivo aninhado fundo),
add-to-chat com e sem chat aberto, fechar variações de aba, tudo em pt-BR e en.

## i18n (chaves novas em `layout.codeIde.*`, pt-BR + en)

Menu/ações: `ctxOpen, ctxNewFile, ctxNewFolder, ctxRename, ctxDelete, ctxCopyPath,
ctxCopyRelPath, ctxRevealFinder, ctxRevealTree, ctxAddToChat, tabClose, tabCloseOthers,
tabCloseRight, tabCloseSaved, tabCloseAll`. Confirmações/toasts: `deleteConfirm,
copiedPath, addedToChat, openChatFirst, renameError, createError, deleteError, revealError,
namePlaceholder`.
