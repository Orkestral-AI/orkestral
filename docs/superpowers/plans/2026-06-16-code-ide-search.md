# IDE Fase 2 — Header Arquivos/Busca + busca de conteúdo com replace

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps `- [ ]`.

**Goal:** Busca de conteúdo em todos os arquivos da source (toggles, resultados agrupados, clicar abre na linha) + substituir em massa + header Arquivos/Busca + Cmd+F.

**Architecture:** 2 IPC no main (`source:search`, `source:replace-all`) iterando arquivos com Node (sem rg). Renderer: `SearchPanel`, toggle de view no header, go-to-line no CodeEditor via `onCreateEditor`, estado novo no `codeIdeStore`.

**Convenções:** sem commit/git; sem testes (gate=typecheck+eslint+build); i18n pt+en `layout.codeIde.search.*`; cn object; sem emoji.

---

## Task 1: Backend — source:search + source:replace-all

**Files:** `src/shared/ipc-contract.ts`, `src/main/ipc/handlers/sources.ts`

- [ ] Contrato (após os canais da Fase 1) + `IPC_CHANNELS`:

```typescript
  'source:search': {
    request: { sourceId: string; query: string; opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } };
    response: { results: Array<{ relPath: string; matches: Array<{ line: number; column: number; preview: string }> }>; truncated: boolean; fileCount: number; matchCount: number };
  };
  'source:replace-all': {
    request: { sourceId: string; query: string; replacement: string; opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } };
    response: { files: number; occurrences: number };
  };
```

- [ ] Helpers no sources.ts (módulo): `escapeRegex`, `buildMatcher(query, opts)`:

```typescript
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function buildMatcher(
  query: string,
  opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean },
): RegExp {
  let pat = opts.regex ? query : escapeRegex(query);
  if (opts.wholeWord) pat = `\\b(?:${pat})\\b`;
  return new RegExp(pat, 'g' + (opts.caseSensitive ? '' : 'i')); // pode lançar (regex inválido)
}
const SEARCH_MATCH_CAP = 2000;
const SEARCH_PER_FILE_CAP = 20;
```

- [ ] Handler `source:search`:

```typescript
registerHandler('source:search', ({ sourceId, query, opts }) => {
  if (!query) return { results: [], truncated: false, fileCount: 0, matchCount: 0 };
  const source = sourceRepo.get(sourceId);
  if (!source?.path || !existsSync(source.path)) throw new Error('source-path-missing');
  let re: RegExp;
  try {
    re = buildMatcher(query, opts);
  } catch {
    throw new Error('bad-regex');
  }
  const root = resolve(source.path);
  const results: Array<{
    relPath: string;
    matches: Array<{ line: number; column: number; preview: string }>;
  }> = [];
  let matchCount = 0;
  let truncated = false;
  for (const rel of listFilesUnder(root)) {
    if (matchCount >= SEARCH_MATCH_CAP) {
      truncated = true;
      break;
    }
    const abs = join(root, rel);
    let buf: Buffer;
    try {
      const st = statSync(abs);
      if (st.size > MAX_FILE_BYTES) continue;
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString('utf-8').split('\n');
    const matches: Array<{ line: number; column: number; preview: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (m) {
        matches.push({ line: i + 1, column: m.index + 1, preview: lines[i].slice(0, 200) });
        matchCount++;
        if (matches.length >= SEARCH_PER_FILE_CAP || matchCount >= SEARCH_MATCH_CAP) break;
      }
    }
    if (matches.length) results.push({ relPath: rel, matches });
  }
  return { results, truncated, fileCount: results.length, matchCount };
});
```

- [ ] Handler `source:replace-all`:

```typescript
registerHandler('source:replace-all', ({ sourceId, query, replacement, opts }) => {
  if (!query) return { files: 0, occurrences: 0 };
  const source = sourceRepo.get(sourceId);
  if (!source?.path || !existsSync(source.path)) throw new Error('source-path-missing');
  let re: RegExp;
  try {
    re = buildMatcher(query, opts);
  } catch {
    throw new Error('bad-regex');
  }
  const root = resolve(source.path);
  let files = 0;
  let occurrences = 0;
  for (const rel of listFilesUnder(root)) {
    const abs = join(root, rel);
    let buf: Buffer;
    try {
      const st = statSync(abs);
      if (st.size > MAX_FILE_BYTES) continue;
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const content = buf.toString('utf-8');
    let n = 0;
    const next = content.replace(re, (...args) => {
      n++;
      return typeof replacement === 'string' ? replacement.replace(/\$&/g, args[0]) : args[0];
    });
    // nota: usar replacement direto deixa $1/$& nativos; simplificar pra content.replace(re, replacement) e contar via match
    if (n > 0) {
      writeFileSync(abs, next, 'utf-8');
      files++;
      occurrences += n;
    }
  }
  return { files, occurrences };
});
```

> Implementador: simplificar a contagem — fazer `const n = (content.match(re) || []).length; if (n) { writeFileSync(abs, content.replace(re, replacement), 'utf-8'); files++; occurrences += n; }`. `replacement` passa direto pro `.replace` (suporta `$1`/`$&` nativo). `re` precisa flag `g` (já tem).

- [ ] `npm run typecheck` PASS. Não commitar.

## Task 2: i18n search.\*

**Files:** pt-BR/layout.json, en/layout.json — adicionar objeto `search` dentro de `codeIde`:
pt-BR: placeholder "Buscar", replacePlaceholder "Substituir", caseSensitive "Diferenciar maiúsculas", wholeWord "Palavra inteira", regex "Expressão regular", resultsCount "{matches} resultados em {files} arquivos", noResults "Nenhum resultado", truncated "Mostrando os primeiros resultados", replaceAll "Substituir tudo", replaceConfirm "Substituir {occurrences} ocorrências em {files} arquivos?", replaced "{occurrences} substituições feitas", badRegex "Expressão regular inválida", searching "Buscando…", viewFiles "Arquivos", viewSearch "Busca", emptyHint "Digite para buscar nos arquivos".
en: equivalentes.

- [ ] typecheck PASS.

## Task 3: codeIdeStore — view + goTo + focusSearch

**Files:** `src/renderer/src/stores/codeIdeStore.ts`

- [ ] Adicionar: `view: 'files' | 'search'` (default 'files'), `setView(v)`; `goTo: { relPath: string; line: number } | null`, `requestGoTo(relPath, line)`, `clearGoTo()`; `focusSearch: number` (0), `bumpFocusSearch()` (incrementa).
- [ ] typecheck PASS.

## Task 4: SearchPanel

**Files:** Create `src/renderer/src/components/code-ide/SearchPanel.tsx`
Props: `{ sourceId: string }`. Usa `useT`, `useQuery`, `useCodeTabsStore.openTab`, `useCodeIdeStore` (requestGoTo, focusSearch), `getFileIconUrl`, `toast`.

- [ ] Inputs (busca + replace) + 3 toggles (estado local: caseSensitive/wholeWord/regex). Debounce do termo ~250ms (useState + useEffect setTimeout) antes de virar queryKey.
- [ ] `useQuery({ queryKey: ['source-search', sourceId, debounced, opts], enabled: debounced.length>0, queryFn: () => window.orkestral['source:search']({sourceId, query: debounced, opts}) })`. Erro (bad-regex) → mostrar `t('...search.badRegex')`.
- [ ] Header: `t('search.resultsCount',{matches,files})` (se o `t` não interpola, montar string no componente); flag truncated → linha `t('search.truncated')`.
- [ ] Lista agrupada: por arquivo (ícone + relPath + count, expansível com framer-motion ou simples), cada match: `preview` com o trecho casado em `<mark>`/span destacado. Clicar → `openTab(relPath, base)` + `requestGoTo(relPath, line)`.
- [ ] Substituir tudo: botão habilitado com replace + resultados; `window.confirm(t('search.replaceConfirm',{occurrences:matchCount,files:fileCount}))` → `source:replace-all` → `toast.success(t('search.replaced',{occurrences}))` → `queryClient.invalidateQueries({queryKey:['source-file', sourceId]})` (refetch dos abertos) + re-roda busca (invalida `['source-search']`).
- [ ] Foco: efeito `useEffect(()=>{ inputRef.current?.focus() }, [focusSearch])`.
- [ ] typecheck + eslint PASS.

## Task 5: CodeEditor go-to-line

**Files:** `src/renderer/src/components/code-ide/CodeEditor.tsx`

- [ ] `const viewRef = useRef<EditorView|null>(null)`; passar `onCreateEditor={(view)=>{viewRef.current=view}}` no `<CodeMirror>`.
- [ ] Ler `goTo`/`clearGoTo` do `useCodeIdeStore`. Efeito: quando `goTo?.relPath===relPath && viewRef.current`, `const v=viewRef.current; const ln=Math.min(goTo.line, v.state.doc.lines); const line=v.state.doc.line(ln); v.dispatch({selection:{anchor:line.from}, scrollIntoView:true}); v.focus(); clearGoTo();` (deps [goTo, relPath]). Importar `EditorView` (já importado).
- [ ] typecheck PASS.

## Task 6: SourceCodePage — header toggle + view switch + Cmd+F

**Files:** `src/renderer/src/pages/SourceCodePage.tsx`

- [ ] Ler `view`/`setView`/`bumpFocusSearch` do `useCodeIdeStore`. No header da aside, 2 botões (lucide `Files`, `Search`) marcando view ativa (cn object). Os botões novo-arquivo/pasta só na view 'files'.
- [ ] Conteúdo da aside: `view==='files' ? <FileTree .../> : <SearchPanel sourceId={sourceId} />`.
- [ ] `useEffect` keydown nativo: `(e.metaKey||e.ctrlKey)&&e.key==='f'` → `e.preventDefault(); setView('search'); bumpFocusSearch();` (cleanup remove). Só enquanto a página monta.
- [ ] typecheck + eslint + `npx electron-vite build` PASS. prettier nos arquivos.

---

## Self-review

- source:search/replace-all (Node, caps, escopo source) → Task 1. ✓
- toggles case/word/regex → Tasks 1,4. ✓
- resultados agrupados + clicar abre na linha → Tasks 4,5. ✓
- replace em massa + confirmação → Task 4. ✓
- header Arquivos/Busca → Task 6. ✓
- Cmd+F → Task 6. ✓
- i18n pt+en → Task 2. ✓
- go-to-line via onCreateEditor → Task 5. ✓
