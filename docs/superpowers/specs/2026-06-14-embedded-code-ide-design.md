# IDE embutida por source — design

**Data:** 2026-06-14
**Status:** aprovado (aguardando review do spec)

## Problema

Hoje pra olhar o código de uma source (ou ver um `.env`) o usuário precisa abrir
Cursor/VSCode em paralelo ao Orkestral. Queremos um visualizador/editor de código
embutido no app, por source, pra eliminar essa troca de janela.

Um workspace pode ter mais de uma source. Cada source aponta pra uma pasta em disco
(`WorkspaceSource.path`), que pode ser repo clonado ou pasta local, com árvore de
pastas arbitrariamente profunda.

## Objetivo (V1)

Tela dedicada estilo VSCode, por source: navegar a árvore de arquivos, abrir vários
arquivos em abas, ver com cor de sintaxe seguindo o tema do app, editar e salvar em disco.

## Fora de escopo (V1)

- Busca global no código (grep)
- Diff/git inline, blame
- Autocomplete / LSP / IntelliSense
- Criar, deletar, renomear, mover arquivo
- Drag-and-drop na árvore
- Múltiplas sources abertas lado a lado

## Decisões

| Tema             | Decisão                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Formato          | Página dedicada, rota `/sources/:sourceId/code`                                                                    |
| Como abrir       | Botão "Abrir código" em cada source (sidebar + `SourceDetailPage`)                                                 |
| Layout           | Árvore à esquerda, abas + editor CodeMirror 6 à direita                                                            |
| Árvore           | Lazy-load — expandir pasta carrega só aquele nível                                                                 |
| Motor editor     | CodeMirror 6 (única dep nova)                                                                                      |
| Tema do código   | CodeMirror theme montado dos tokens de `codeThemes.ts`, lendo tema ativo do `settingsStore`; reage a troca de tema |
| Salvar           | Explícito `Cmd/Ctrl+S`. Sem autosave                                                                               |
| Estado sujo      | Bolinha na aba; fechar aba suja pede confirmação                                                                   |
| Abas             | Várias por vez, escopo da página da source. Trocar source = outra página                                           |
| `.env`           | Arquivo de texto normal, sem máscara                                                                               |
| Binário / grande | `> 2MB` ou binário: placeholder "preview não disponível", sem editor                                               |
| Segurança        | Todo IPC valida que o path resolvido está dentro de `source.path`                                                  |

## Arquitetura

### Main (Electron) — novos IPC handlers

Em `src/main/ipc/handlers/sources.ts`, reusando os ignores e o resolver de path já
existentes em `listFilesUnder`/`listSubdirs`.

Helper compartilhado `resolveInsideSource(sourceId, relPath)`:

1. Carrega a source, pega `source.path` (rejeita se `path` for null).
2. `resolved = path.resolve(sourcePath, relPath)`.
3. Rejeita se `resolved` não começa com `sourcePath` normalizado (anti path-traversal).
4. Retorna `resolved`.

- **`source:read-dir`** — request `{ sourceId, relPath }` (relPath `''` = raiz).
  Lista **um nível** com `readdirSync(..., { withFileTypes: true })`. Aplica a mesma
  ignore-list (`node_modules`, `.git`, `dist`, `build`, etc). Retorna
  `Array<{ name, relPath, kind: 'dir' | 'file' }>`, dirs antes de files, ordem alfabética.
- **`source:read-file`** — request `{ sourceId, relPath }`. Resolve, valida.
  `statSync`: se `size > 2MB` retorna `{ tooLarge: true }`. Lê os primeiros bytes pra
  heurística de binário (presença de byte nulo) → `{ binary: true }`. Senão lê utf-8 e
  retorna `{ content, size }`.
- **`source:write-file`** — request `{ sourceId, relPath, content }`. Resolve, valida.
  Só escreve se o arquivo **já existe** (`existsSync`); rejeita caso contrário — criar
  arquivo novo está fora de escopo. `writeFileSync` utf-8, retorna `{ ok: true }`.

Registrar os 3 canais no `ipc-contract.ts` (request/response types) e no preload (o
preload já monta `window.orkestral[canal]` dinamicamente — só precisa o canal existir
no contrato).

### Renderer — componentes

Página: `src/renderer/src/pages/SourceCodePage.tsx` (lazy-load no `router.tsx`,
rota `/sources/:sourceId/code`, dentro do `AppShell`).

- **`SourceCodePage`** — pega `sourceId` via `useParams`, carrega a source
  (`source:list` filtrado ou handler de get existente). Monta o layout de 2 colunas
  e provê o store de abas. Estados de loading/erro (source sem `path`).
- **`FileTree`** — árvore lazy. Cada nó pasta usa `useQuery(['source-dir', sourceId, relPath])`
  → `source:read-dir`, só dispara quando expandido. Recursivo (modelo do `KbSidebarPageRow`),
  expand/collapse com `framer-motion`, ícone por tipo (lucide). Clique em arquivo → abre aba.
- **`EditorTabs`** — barra de abas dos arquivos abertos, bolinha de dirty, botão fechar
  (confirma se sujo). Aba ativa controla o editor.
- **`CodeEditor`** — wrapper do CodeMirror 6. Carrega conteúdo via
  `useQuery(['source-file', sourceId, relPath])` → `source:read-file`. Language extension
  por extensão do arquivo. Tema derivado do `settingsStore` (recalcula quando tema muda).
  `Cmd/Ctrl+S` → mutation `source:write-file`, marca aba como limpa.
- **`useCodeTabsStore`** (zustand) — abas abertas `[{ relPath, dirty, content }]`,
  aba ativa, ações `openTab`/`closeTab`/`setActive`/`markDirty`/`markSaved`.

### CodeMirror theme

Função `buildCmTheme(codeThemeColors)` que converte o `CodeThemeColors` (já existente)
num `EditorView.theme` + `HighlightStyle` do CodeMirror, mapeando:
`keyword → tokens.keyword`, `string → tokens.string`, `comment → tokens.comment`,
`number`, `function`/`variableName`, `typeName → tokens.type`, fundo/fg/linha do
`bg`/`fg`/`lineNum`/`border`. Recalcula via `useMemo` dependente do tema ativo.

## Fluxos de dados

**Abrir página:** clique no botão → navega `/source/:id/code` → carrega source →
`FileTree` pede raiz (`source:read-dir relPath:''`).

**Expandir pasta:** clique → query `source:read-dir` daquele relPath → renderiza filhos.

**Abrir arquivo:** clique no arquivo → `openTab(relPath)` → `CodeEditor` faz query
`source:read-file`. Se `tooLarge`/`binary` → placeholder.

**Editar + salvar:** digitar marca aba dirty → `Cmd+S` → `source:write-file` →
`markSaved`. Sem autosave.

**Trocar tema do app:** `settingsStore` muda → `buildCmTheme` recalcula → editor re-renderiza.

## Erros

- Source sem `path` (ex: repo não clonado ainda): página mostra estado vazio explicando.
- IPC read/write falha (permissão, arquivo sumiu): toast de erro, aba não marca como salva.
- Path fora da source: IPC rejeita; não deve acontecer pela UI, é defesa.
- Arquivo editado externamente entre abrir e salvar: V1 sobrescreve (sem merge); aceitável,
  documentar como limitação conhecida.

## Validação

Sem testes automatizados (não é prática do projeto). Gate = `npm run typecheck` limpo +
revisão manual: abrir source, navegar pasta profunda, abrir `.env` e um `.tsx`, editar,
`Cmd+S`, reabrir e confirmar persistência, trocar tema e ver cores mudarem.

## Dependência nova

CodeMirror 6: `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`,
`@codemirror/language`, `@codemirror/lang-javascript` (+ langs conforme extensões comuns:
json, css, html, python, markdown). Avaliar `@uiw/react-codemirror` como wrapper React
pra reduzir boilerplate.
