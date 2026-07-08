# IDE embutida — Fase 2: header Arquivos/Busca + busca de conteúdo com replace

**Data:** 2026-06-16
**Status:** aprovado (escopo validado no brainstorm das fases; "segue a fase 2")

## Objetivo

Header tipo activity-bar pra alternar **Arquivos / Busca** na coluna esquerda da IDE,
e uma busca de conteúdo em todos os arquivos da source (toggles maiúsc./palavra/regex),
com resultados agrupados por arquivo (clicar abre na linha) e **substituir em massa**.
Atalho **Cmd/Ctrl+F** abre a busca.

## Decisões travadas

| Tema              | Decisão                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Motor de busca    | Node no main iterando arquivos (reusa `listFilesUnder`, caps). NÃO depende do binário `rg` (não é bundlado)                 |
| Toggles           | case-sensitive, whole-word, regex (como VSCode)                                                                             |
| Replace           | `replace-all` em massa; **confirmação com contagem** antes de escrever                                                      |
| Resultado → abrir | abre a aba e pula pra linha (via `onCreateEditor` do CodeMirror)                                                            |
| View switch       | toggle de 2 ícones (Arquivos/Busca) no header da aside; estado em `codeIdeStore`                                            |
| Cmd+F             | na rota da IDE, abre a view Busca e foca o input                                                                            |
| Caps              | scan até `MAX_FILES_MENTION` (4000) arquivos; ~20 matches/arquivo; ~2000 matches total; pula binário/>2MB; flag `truncated` |
| i18n              | pt-BR + en, `layout.codeIde.search.*`                                                                                       |
| Segurança         | busca/replace escopados em `source.path` (resolve via root da source; sem traversal)                                        |

## Backend (Electron main) — `sources.ts` + `ipc-contract.ts`

Reusa `listFilesUnder(root)` (BFS, cap 4000, pula dot-dirs/IGNORE_DIRS, depth 6),
`looksBinary`, `MAX_FILE_BYTES`, e o carregamento de source (`sourceRepo.get`).

Helper `buildMatcher(query, opts)`:

- `regex`: `new RegExp(query, flags)` em try/catch → throw `bad-regex` se inválido.
- senão: escapa metacaracteres; `wholeWord` envolve com `\b…\b`.
- flags = `'g'` + (`caseSensitive` ? `''` : `'i'`).

- **`source:search`** — req `{ sourceId, query, opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } }`.
  Resp `{ results: Array<{ relPath: string; matches: Array<{ line: number; column: number; preview: string }> }>; truncated: boolean; fileCount: number; matchCount: number }`.
  - query vazia → `{ results: [], truncated: false, fileCount: 0, matchCount: 0 }`.
  - resolve `root` da source; `listFilesUnder(root)`; para cada arquivo: lê (pula se size>MAX_FILE_BYTES ou `looksBinary`); por linha aplica o matcher; coleta `{ line (1-based), column, preview (a linha, trim a ~200 chars) }`; cap ~20/arquivo. Para no cap total (~2000) e marca `truncated`.
- **`source:replace-all`** — req `{ sourceId, query, replacement, opts }`.
  Resp `{ files: number; occurrences: number }`.
  - mesmo matcher; para cada arquivo com match, `content.replace(regex, replacement)`, conta ocorrências, `writeFileSync`. Cap de arquivos = mesmo do scan. (regex `replacement` suporta `$1` nativo do JS.)

Adicionar os 2 canais ao `IpcContract` E à `IPC_CHANNELS`.

## Renderer

### Store — `codeIdeStore.ts` (adições)

- `view: 'files' | 'search'` + `setView(v)`.
- `goTo: { relPath: string; line: number } | null` + `requestGoTo(relPath, line)` / `clearGoTo()`.
- `focusSearch: number` (contador) + `bumpFocusSearch()` — pra Cmd+F focar o input mesmo se já na view Busca.

### Header toggle — `SourceCodePage.tsx`

No header da aside, 2 botões de ícone (Files, Search — lucide `Files`/`Search`) marcando a
view ativa (cn object). O conteúdo da aside renderiza `<FileTree/>` quando `view==='files'`,
senão `<SearchPanel/>`. Os botões "novo arquivo/pasta" só aparecem na view Arquivos.

### `SearchPanel.tsx` (novo)

- Input de busca + input de replace + 3 toggles (Aa, palavra, `.*`) com estado local.
- Busca via `useQuery(['source-search', sourceId, query, opts], …)` com `enabled: query.length>0`,
  debounce ~250ms (debounce o termo antes de virar queryKey).
- Cabeçalho de contagem: "N resultados em M arquivos" (i18n) + flag truncado.
- Lista agrupada por arquivo (ícone material + relPath + contagem), expansível; cada match
  mostra `preview` com o trecho casado destacado. Clicar no match → `openTab(relPath, base)`
  - `requestGoTo(relPath, line)`.
- Botão **Substituir tudo** (habilita com replace preenchido + resultados): `window.confirm`
  com contagem (i18n) → `source:replace-all` → toast → invalida `['source-file', sourceId, *]`
  dos arquivos abertos e re-roda a busca.
- Regex inválido: o backend lança `bad-regex` → mostra estado de erro no painel (i18n), sem crash.
- Recebe `focusSearch` do store: efeito foca o input quando o contador muda.

### Go-to-line — `CodeEditor.tsx`

Captura a `EditorView` via `onCreateEditor={(view) => (viewRef.current = view)}`. Efeito:
quando `goTo?.relPath === relPath`, calcula `pos` da `line` (`view.state.doc.line(min(line, doc.lines))`),
`view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })`, foca, e `clearGoTo()`.
Como o editor remonta por arquivo (`key={activePath}`), abrir outro arquivo e então aplicar o
goTo funciona; se o arquivo já está aberto, o efeito dispara na mudança de `goTo`.

### Cmd+F — `SourceCodePage.tsx`

`useEffect` adiciona listener nativo de `keydown` (enquanto a página monta): se `(meta||ctrl) && key==='f'`,
`preventDefault`, `setView('search')`, `bumpFocusSearch()`. Remove no cleanup. (Não mexe no
registry global de shortcuts pra não conflitar com busca global do app — escopo só na IDE.)

## Erros

- `bad-regex` → painel mostra mensagem i18n, lista vazia.
- read falha num arquivo → pula esse arquivo (não aborta a busca).
- replace falha num arquivo → conta os que deram certo, toast com aviso i18n.
- query vazia → estado inicial (dica), sem chamada.

## Validação

Sem testes (padrão Orkestral). Gate: `npm run typecheck` + `npx eslint` + `npx electron-vite build`.
Manual: buscar termo comum (ver contagem/agrupamento), toggles (case/word/regex), regex inválido,
clicar match (abre+pula linha), substituir tudo (confirма+conta), Cmd+F (abre busca focada),
alternar Arquivos/Busca, em pt e en.

## i18n (`layout.codeIde.search.*`, pt-BR + en)

`placeholder, replacePlaceholder, caseSensitive, wholeWord, regex, resultsCount` (com {matches}/{files}),
`noResults, truncated, replaceAll, replaceConfirm` (com {occurrences}/{files}), `replaced` (com {occurrences}),
`badRegex, searching, viewFiles, viewSearch, emptyHint`.
