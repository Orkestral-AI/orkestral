# IDE embutida por source — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tela dedicada por source (estilo VSCode) pra navegar a árvore de arquivos, abrir vários arquivos em abas, ver com cor de sintaxe seguindo o tema do app, editar e salvar em disco — sem abrir Cursor/VSCode.

**Architecture:** 3 novos IPC handlers no main (Electron) leem/escrevem arquivos validando que o path resolvido fica dentro de `source.path` (anti path-traversal). No renderer, uma rota `/sources/:sourceId/code` com layout de 2 colunas: `FileTree` lazy (carrega 1 nível por expansão via React Query) + editor CodeMirror 6 com abas. O tema do editor é derivado dos tokens `CodeThemeColors` já existentes.

**Tech Stack:** Electron + React 19 + React Router v7 (HashRouter) + zustand + TanStack React Query + Tailwind v4 + CodeMirror 6 (nova dep).

**Convenções do projeto (importantes):**

- Sem test runner. Gate de validação = `npm run typecheck` limpo + verificação manual no app (`npm run dev`). NÃO criar arquivos de teste.
- Sem emoji. Ícones via `lucide-react`.
- Não usar variant/cor `secondary`. Usar `default`/`primary` ou `outline`/`muted`.
- Classes condicionais via `cn({classe: cond})`, não ternário.
- **Commits e git só com autorização explícita do Luccas.** Os passos de commit abaixo são checkpoints — só executar quando ele pedir.

---

## Estrutura de arquivos

**Criar:**

- `src/renderer/src/pages/SourceCodePage.tsx` — página/rota, layout 2 colunas, carrega a source.
- `src/renderer/src/components/code-ide/FileTree.tsx` — árvore lazy de pastas/arquivos.
- `src/renderer/src/components/code-ide/CodeEditor.tsx` — wrapper do CodeMirror 6.
- `src/renderer/src/components/code-ide/EditorTabs.tsx` — barra de abas + dirty + fechar.
- `src/renderer/src/stores/codeTabsStore.ts` — zustand: abas abertas, ativa, dirty.
- `src/renderer/src/lib/cmTheme.ts` — `buildCmTheme(colors)` + `languageForPath(path)`.

**Modificar:**

- `src/shared/ipc-contract.ts` — adicionar 3 canais ao `IpcContract` + à lista de canais.
- `src/main/ipc/handlers/sources.ts` — helper `resolveInsideSource` + 3 handlers.
- `src/renderer/src/router.tsx` — registrar rota `/sources/:sourceId/code`.
- `src/renderer/src/components/layout/Sidebar.tsx` — botão "Abrir código" na linha do source.
- `src/renderer/src/pages/SourceDetailPage.tsx` — botão "Abrir código".
- `package.json` — deps do CodeMirror.

---

## Task 1: Instalar CodeMirror 6

**Files:**

- Modify: `package.json` (via npm)

- [ ] **Step 1: Instalar as deps**

O projeto usa **npm** (não pnpm). Rodar na raiz do repo:

```bash
npm install @uiw/react-codemirror @codemirror/state @codemirror/view @codemirror/language @codemirror/commands @codemirror/lang-javascript @codemirror/lang-json @codemirror/lang-css @codemirror/lang-html @codemirror/lang-python @codemirror/lang-markdown @lezer/highlight
```

`@uiw/react-codemirror` é o wrapper React (reduz boilerplate de montar o EditorView na mão). `@lezer/highlight` expõe os `tags` usados pra mapear cores.

- [ ] **Step 2: Verificar instalação**

Run: `npm ls @uiw/react-codemirror @codemirror/view`
Expected: lista as versões instaladas, sem `UNMET DEPENDENCY`.

- [ ] **Step 3: Commit (checkpoint — só com autorização)**

```bash
git add package.json package-lock.json
git commit -m "build: add codemirror 6 deps for embedded code ide"
```

---

## Task 2: Contrato IPC dos 3 canais

**Files:**

- Modify: `src/shared/ipc-contract.ts` (bloco de `'source:*'` ~linha 1461; lista de canais ~linha 2133)

- [ ] **Step 1: Adicionar os 3 canais ao `IpcContract`**

Logo após o bloco `'source:scan-folder'` (que termina em `};` na ~linha 1474), adicionar:

```typescript
  /** Lista UM nível de uma pasta dentro de uma source. relPath '' = raiz da source.
   *  Valida que o path resolvido fica dentro de source.path. Dirs antes de files. */
  'source:read-dir': {
    request: { sourceId: string; relPath: string };
    response: Array<{ name: string; relPath: string; kind: 'dir' | 'file' }>;
  };
  /** Lê um arquivo de texto dentro da source. Retorna binary/tooLarge quando não dá
   *  pra editar (byte nulo nos primeiros bytes, ou size > 2MB). */
  'source:read-file': {
    request: { sourceId: string; relPath: string };
    response:
      | { content: string; size: number; binary?: false; tooLarge?: false }
      | { binary: true }
      | { tooLarge: true; size: number };
  };
  /** Escreve um arquivo JÁ EXISTENTE dentro da source (utf-8). Rejeita criação. */
  'source:write-file': {
    request: { sourceId: string; relPath: string; content: string };
    response: { ok: true };
  };
```

- [ ] **Step 2: Adicionar os 3 canais à lista de nomes de canais**

Na lista de strings de canais (logo após `'source:scan-folder',` na ~linha 2134), adicionar:

```typescript
  'source:read-dir',
  'source:read-file',
  'source:write-file',
```

- [ ] **Step 3: Verificar typecheck**

Run: `npm run typecheck`
Expected: PASS (sem erro). Se acusar canal duplicado ou faltando na lista, conferir os 2 lugares.

- [ ] **Step 4: Commit (checkpoint — só com autorização)**

```bash
git add src/shared/ipc-contract.ts
git commit -m "feat(ipc): add read-dir/read-file/write-file source channels"
```

---

## Task 3: Handlers no main (com guarda de path)

**Files:**

- Modify: `src/main/ipc/handlers/sources.ts` (helpers ~linha 255; `registerSourcesHandlers` ~linha 285)

Imports já presentes no topo do arquivo: `readdirSync`, `existsSync`, `join` (de `fs`/`path`) e `sourceRepo` (instância de `WorkspaceSourceRepository`, linha 19). Vamos precisar também de `statSync`, `readFileSync`, `writeFileSync`, `resolve`, `sep`.

- [ ] **Step 1: Garantir os imports de fs/path**

No topo de `sources.ts`, confirmar/expandir os imports:

```typescript
import { readdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';
```

(Se já houver `import { readdirSync, existsSync } from 'fs'`, só adicionar os que faltam ao mesmo import.)

- [ ] **Step 2: Adicionar o helper `resolveInsideSource` perto dos outros helpers (após `listSubdirs`, ~linha 283)**

```typescript
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB: acima disso não abre no editor

/** Resolve `relPath` contra a raiz da source e GARANTE que o resultado fica dentro
 *  dela (anti path-traversal). Lança se a source não existe, não tem path, ou o
 *  path escapa. Retorna o caminho absoluto validado + a source. */
function resolveInsideSource(sourceId: string, relPath: string): { abs: string; root: string } {
  const source = sourceRepo.get(sourceId);
  if (!source) throw new Error('source-not-found');
  if (!source.path || !existsSync(source.path)) throw new Error('source-path-missing');
  const root = resolve(source.path);
  const abs = resolve(root, relPath);
  // `abs` precisa ser a própria raiz OU começar com raiz + separador. Sem isso,
  // `../etc/passwd` ou um prefixo coincidente (`/root-evil`) passariam.
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('path-escapes-source');
  return { abs, root };
}

/** Heurística de binário: byte nulo nos primeiros 8KB. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
```

- [ ] **Step 3: Registrar `source:read-dir` dentro de `registerSourcesHandlers` (junto dos outros `source:*`)**

```typescript
registerHandler('source:read-dir', ({ sourceId, relPath }) => {
  const { abs } = resolveInsideSource(sourceId, relPath);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ name: string; relPath: string; kind: 'dir' | 'file' }> = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env') {
      // mantém dot-dirs de ruído fora, MAS deixa .env visível (é o caso de uso)
      if (e.isDirectory()) continue;
    }
    if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
    const childRel = relPath ? `${relPath}/${e.name}` : e.name;
    if (e.isDirectory()) out.push({ name: e.name, relPath: childRel, kind: 'dir' });
    else if (e.isFile()) out.push({ name: e.name, relPath: childRel, kind: 'file' });
  }
  // dirs antes de files, cada grupo alfabético (case-insensitive)
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return out;
});
```

- [ ] **Step 4: Registrar `source:read-file`**

```typescript
registerHandler('source:read-file', ({ sourceId, relPath }) => {
  const { abs } = resolveInsideSource(sourceId, relPath);
  const stat = statSync(abs);
  if (!stat.isFile()) throw new Error('not-a-file');
  if (stat.size > MAX_FILE_BYTES) return { tooLarge: true as const, size: stat.size };
  const buf = readFileSync(abs);
  if (looksBinary(buf)) return { binary: true as const };
  return { content: buf.toString('utf-8'), size: stat.size };
});
```

- [ ] **Step 5: Registrar `source:write-file`**

```typescript
registerHandler('source:write-file', ({ sourceId, relPath, content }) => {
  const { abs } = resolveInsideSource(sourceId, relPath);
  if (!existsSync(abs)) throw new Error('file-not-found'); // criação fora de escopo
  writeFileSync(abs, content, 'utf-8');
  return { ok: true as const };
});
```

- [ ] **Step 6: Verificar typecheck**

Run: `npm run typecheck`
Expected: PASS. Tipos do request/response batem com o contrato da Task 2.

- [ ] **Step 7: Commit (checkpoint — só com autorização)**

```bash
git add src/main/ipc/handlers/sources.ts
git commit -m "feat(main): file read/write handlers with path-traversal guard"
```

---

## Task 4: Store de abas (zustand)

**Files:**

- Create: `src/renderer/src/stores/codeTabsStore.ts`

- [ ] **Step 1: Criar o store**

```typescript
import { create } from 'zustand';

export interface CodeTab {
  relPath: string; // chave única da aba (relativo à source)
  name: string; // basename pra exibir
  dirty: boolean;
  /** Conteúdo em edição. undefined enquanto o arquivo ainda carrega. */
  draft?: string;
}

interface CodeTabsState {
  tabs: CodeTab[];
  activePath: string | null;
  openTab: (relPath: string, name: string) => void;
  closeTab: (relPath: string) => void;
  setActive: (relPath: string) => void;
  setDraft: (relPath: string, draft: string) => void;
  markSaved: (relPath: string) => void;
  reset: () => void;
}

export const useCodeTabsStore = create<CodeTabsState>((set) => ({
  tabs: [],
  activePath: null,
  openTab: (relPath, name) =>
    set((s) => {
      if (s.tabs.some((t) => t.relPath === relPath)) return { activePath: relPath };
      return { tabs: [...s.tabs, { relPath, name, dirty: false }], activePath: relPath };
    }),
  closeTab: (relPath) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.relPath !== relPath);
      const activePath =
        s.activePath === relPath ? (tabs[tabs.length - 1]?.relPath ?? null) : s.activePath;
      return { tabs, activePath };
    }),
  setActive: (relPath) => set({ activePath: relPath }),
  setDraft: (relPath, draft) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.relPath === relPath ? { ...t, draft, dirty: true } : t)),
    })),
  markSaved: (relPath) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.relPath === relPath ? { ...t, dirty: false } : t)),
    })),
  reset: () => set({ tabs: [], activePath: null }),
}));
```

- [ ] **Step 2: Verificar typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit (checkpoint — só com autorização)**

```bash
git add src/renderer/src/stores/codeTabsStore.ts
git commit -m "feat(renderer): code tabs zustand store"
```

---

## Task 5: Tema do CodeMirror + detecção de linguagem

**Files:**

- Create: `src/renderer/src/lib/cmTheme.ts`

Referência de tokens: `CodeThemeColors` em `src/renderer/src/lib/codeThemes.ts` (campos `bg, fg, comment, keyword, string, number, function, variable, type, border, lineNum`).

- [ ] **Step 1: Criar `cmTheme.ts`**

```typescript
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting, LanguageSupport } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import type { Extension } from '@codemirror/state';
import type { CodeThemeColors } from '@renderer/lib/codeThemes';

/** Constrói as extensões de tema (UI + highlight) do CodeMirror a partir dos
 *  tokens do tema ativo do app. */
export function buildCmTheme(c: CodeThemeColors): Extension {
  const view = EditorView.theme(
    {
      '&': { backgroundColor: c.bg, color: c.fg },
      '.cm-content': { caretColor: c.fg },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: c.fg },
      '.cm-gutters': { backgroundColor: c.bg, color: c.lineNum, border: 'none' },
      '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)' },
      '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(120,150,255,0.25)' },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(120,150,255,0.3)' },
      '.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
    },
    { dark: true },
  );

  const highlight = HighlightStyle.define([
    { tag: t.comment, color: c.comment, fontStyle: 'italic' },
    { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: c.keyword },
    { tag: [t.string, t.special(t.string)], color: c.string },
    { tag: [t.number, t.bool, t.null], color: c.number },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: c.function },
    { tag: [t.variableName, t.propertyName], color: c.variable },
    { tag: [t.typeName, t.className, t.tagName], color: c.type },
    { tag: [t.definition(t.variableName)], color: c.variable },
  ]);

  return [view, syntaxHighlighting(highlight)];
}

/** Escolhe o LanguageSupport pela extensão do arquivo. Sem match = texto puro. */
export function languageForPath(relPath: string): LanguageSupport | null {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: true });
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'json':
      return json();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'html':
    case 'htm':
    case 'vue':
      return html();
    case 'py':
      return python();
    case 'md':
    case 'markdown':
      return markdown();
    default:
      return null; // .env, .txt, .yml etc: sem highlight de linguagem (só tema)
  }
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npm run typecheck`
Expected: PASS. Se algum `t.<tag>` não existir na versão do `@lezer/highlight`, remover só aquela linha (a lista de tags varia entre versões).

- [ ] **Step 3: Commit (checkpoint — só com autorização)**

```bash
git add src/renderer/src/lib/cmTheme.ts
git commit -m "feat(renderer): codemirror theme builder from app theme tokens"
```

---

## Task 6: FileTree (árvore lazy)

**Files:**

- Create: `src/renderer/src/components/code-ide/FileTree.tsx`

- [ ] **Step 1: Criar o componente**

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, ChevronDown, Folder, FolderOpen, File as FileIcon } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

type Entry = { name: string; relPath: string; kind: 'dir' | 'file' };

export function FileTree({
  sourceId,
  onOpenFile,
  activePath,
}: {
  sourceId: string;
  onOpenFile: (relPath: string, name: string) => void;
  activePath: string | null;
}) {
  return (
    <div className="h-full overflow-y-auto py-1 text-[12.5px]">
      <DirNode
        sourceId={sourceId}
        relPath=""
        name=""
        depth={0}
        isRoot
        onOpenFile={onOpenFile}
        activePath={activePath}
      />
    </div>
  );
}

function DirNode({
  sourceId,
  relPath,
  name,
  depth,
  isRoot = false,
  onOpenFile,
  activePath,
}: {
  sourceId: string;
  relPath: string;
  name: string;
  depth: number;
  isRoot?: boolean;
  onOpenFile: (relPath: string, name: string) => void;
  activePath: string | null;
}) {
  const [open, setOpen] = useState(isRoot); // raiz já aberta; resto fechado
  const dirQuery = useQuery({
    queryKey: ['source-dir', sourceId, relPath],
    queryFn: () => window.orkestral['source:read-dir']({ sourceId, relPath }),
    enabled: open, // lazy: só busca quando expande
  });
  const entries: Entry[] = dirQuery.data ?? [];

  return (
    <div>
      {!isRoot && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex h-7 w-full items-center gap-1 rounded-md px-1 text-left text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
          )}
          {open ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 opacity-80" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 opacity-80" />
          )}
          <span className="truncate">{name}</span>
        </button>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            {entries.map((e) =>
              e.kind === 'dir' ? (
                <DirNode
                  key={e.relPath}
                  sourceId={sourceId}
                  relPath={e.relPath}
                  name={e.name}
                  depth={depth + 1}
                  onOpenFile={onOpenFile}
                  activePath={activePath}
                />
              ) : (
                <button
                  key={e.relPath}
                  type="button"
                  onClick={() => onOpenFile(e.relPath, e.name)}
                  className={cn(
                    'flex h-7 w-full items-center gap-1 rounded-md px-1 text-left transition-colors',
                    {
                      'bg-surface-active text-text-primary': activePath === e.relPath,
                      'text-text-secondary hover:bg-surface-hover hover:text-text-primary':
                        activePath !== e.relPath,
                    },
                  )}
                  style={{ paddingLeft: (depth + 1) * 12 + 18 }}
                >
                  <FileIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="truncate">{e.name}</span>
                </button>
              ),
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npm run typecheck`
Expected: PASS. Conferir que `cn` vem de `@renderer/lib/utils` (mesmo import usado pela Sidebar).

- [ ] **Step 3: Commit (checkpoint — só com autorização)**

```bash
git add src/renderer/src/components/code-ide/FileTree.tsx
git commit -m "feat(renderer): lazy file tree for code ide"
```

---

## Task 7: CodeEditor (wrapper CodeMirror)

**Files:**

- Create: `src/renderer/src/components/code-ide/CodeEditor.tsx`

- [ ] **Step 1: Criar o componente**

```tsx
import { useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Loader2, FileWarning } from 'lucide-react';
import { useSettingsStore } from '@renderer/stores/settingsStore';
import { getCodeTheme } from '@renderer/lib/codeThemes';
import { buildCmTheme, languageForPath } from '@renderer/lib/cmTheme';
import { useCodeTabsStore } from '@renderer/stores/codeTabsStore';

function useActiveCodeColors() {
  const settings = useSettingsStore((s) => s.settings);
  return useMemo(() => {
    const id = settings?.appearance.codeTheme ?? 'default';
    const themeMode = settings?.appearance.theme ?? 'dark';
    const resolved =
      themeMode === 'light'
        ? 'light'
        : themeMode === 'system'
          ? window.matchMedia?.('(prefers-color-scheme: light)').matches
            ? 'light'
            : 'dark'
          : 'dark';
    const preset = getCodeTheme(id);
    return resolved === 'light' ? preset.light.colors : preset.dark.colors;
  }, [settings?.appearance.codeTheme, settings?.appearance.theme]);
}

export function CodeEditor({
  sourceId,
  relPath,
  onSave,
}: {
  sourceId: string;
  relPath: string;
  onSave: (relPath: string, content: string) => void;
}) {
  const colors = useActiveCodeColors();
  const setDraft = useCodeTabsStore((s) => s.setDraft);
  const tab = useCodeTabsStore((s) => s.tabs.find((t) => t.relPath === relPath));

  const fileQuery = useQuery({
    queryKey: ['source-file', sourceId, relPath],
    queryFn: () => window.orkestral['source:read-file']({ sourceId, relPath }),
  });

  const extensions = useMemo(() => {
    const lang = languageForPath(relPath);
    const saveKey = keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: (view) => {
          onSave(relPath, view.state.doc.toString());
          return true;
        },
      },
    ]);
    return [buildCmTheme(colors), EditorView.lineWrapping, saveKey, ...(lang ? [lang] : [])];
  }, [colors, relPath, onSave]);

  const handleChange = useCallback(
    (value: string) => setDraft(relPath, value),
    [relPath, setDraft],
  );

  if (fileQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
      </div>
    );
  }
  const data = fileQuery.data;
  if (!data || fileQuery.isError) {
    return <EditorPlaceholder icon label="Não foi possível ler este arquivo." />;
  }
  if ('binary' in data && data.binary) {
    return <EditorPlaceholder icon label="Arquivo binário — preview não disponível." />;
  }
  if ('tooLarge' in data && data.tooLarge) {
    return (
      <EditorPlaceholder
        icon
        label={`Arquivo muito grande (${Math.round(data.size / 1024)} KB) — preview não disponível.`}
      />
    );
  }

  // draft (edição em curso) tem precedência sobre o conteúdo do disco.
  const value = tab?.draft ?? ('content' in data ? data.content : '');

  return (
    <div className="h-full overflow-hidden" style={{ backgroundColor: colors.bg }}>
      <CodeMirror
        value={value}
        height="100%"
        theme="none"
        extensions={extensions}
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
        onChange={handleChange}
      />
    </div>
  );
}

function EditorPlaceholder({ label }: { icon?: boolean; label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
      <FileWarning className="h-6 w-6 opacity-60" />
      <p className="text-[13px]">{label}</p>
    </div>
  );
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npm run typecheck`
Expected: PASS. Se `theme="none"` reclamar do tipo, usar `theme={undefined}` (o tema real vem das extensions de `buildCmTheme`).

- [ ] **Step 3: Commit (checkpoint — só com autorização)**

```bash
git add src/renderer/src/components/code-ide/CodeEditor.tsx
git commit -m "feat(renderer): codemirror editor wrapper with save + theme"
```

---

## Task 8: EditorTabs (abas + dirty + fechar)

**Files:**

- Create: `src/renderer/src/components/code-ide/EditorTabs.tsx`

- [ ] **Step 1: Criar o componente**

```tsx
import { X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useCodeTabsStore } from '@renderer/stores/codeTabsStore';

export function EditorTabs() {
  const tabs = useCodeTabsStore((s) => s.tabs);
  const activePath = useCodeTabsStore((s) => s.activePath);
  const setActive = useCodeTabsStore((s) => s.setActive);
  const closeTab = useCodeTabsStore((s) => s.closeTab);

  if (tabs.length === 0) return null;

  const handleClose = (relPath: string, dirty: boolean) => {
    if (dirty && !window.confirm('Fechar sem salvar? As alterações serão perdidas.')) return;
    closeTab(relPath);
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-hairline-soft">
      {tabs.map((tab) => (
        <div
          key={tab.relPath}
          className={cn(
            'group flex items-center gap-1.5 border-r border-hairline-faint px-3 text-[12px] transition-colors',
            {
              'bg-surface-1 text-text-primary': tab.relPath === activePath,
              'text-text-muted hover:bg-surface-subtle hover:text-text-secondary':
                tab.relPath !== activePath,
            },
          )}
        >
          <button type="button" onClick={() => setActive(tab.relPath)} className="truncate">
            {tab.name}
          </button>
          {tab.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary" />}
          <button
            type="button"
            onClick={() => handleClose(tab.relPath, tab.dirty)}
            className="ml-0.5 grid h-4 w-4 place-items-center rounded text-text-faint opacity-0 transition-opacity hover:bg-surface-strong hover:text-text-primary group-hover:opacity-100"
            aria-label="Fechar aba"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit (checkpoint — só com autorização)**

```bash
git add src/renderer/src/components/code-ide/EditorTabs.tsx
git commit -m "feat(renderer): editor tabs with dirty indicator"
```

---

## Task 9: SourceCodePage + rota

**Files:**

- Create: `src/renderer/src/pages/SourceCodePage.tsx`
- Modify: `src/renderer/src/router.tsx` (lazy import ~linha 38; `<Route>` ~linha 130)

- [ ] **Step 1: Criar a página**

```tsx
import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, FolderX } from 'lucide-react';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { FileTree } from '@renderer/components/code-ide/FileTree';
import { CodeEditor } from '@renderer/components/code-ide/CodeEditor';
import { EditorTabs } from '@renderer/components/code-ide/EditorTabs';
import { useCodeTabsStore } from '@renderer/stores/codeTabsStore';

export function SourceCodePage() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const workspace = useWorkspaceStore((s) => s.active);
  const queryClient = useQueryClient();
  const openTab = useCodeTabsStore((s) => s.openTab);
  const activePath = useCodeTabsStore((s) => s.activePath);
  const markSaved = useCodeTabsStore((s) => s.markSaved);
  const reset = useCodeTabsStore((s) => s.reset);

  // Trocar de source (outra página) zera as abas.
  useEffect(() => () => reset(), [sourceId, reset]);

  const sourcesQuery = useQuery({
    queryKey: ['sources', workspace?.id],
    enabled: !!workspace?.id,
    queryFn: () => window.orkestral['source:list']({ workspaceId: workspace!.id }),
  });
  const source = sourcesQuery.data?.find((s) => s.id === sourceId);

  const saveMutation = useMutation({
    mutationFn: (vars: { relPath: string; content: string }) =>
      window.orkestral['source:write-file']({ sourceId: sourceId!, ...vars }),
    onSuccess: (_res, vars) => {
      markSaved(vars.relPath);
      // sincroniza o cache de leitura com o que acabou de ir pro disco
      queryClient.setQueryData(['source-file', sourceId, vars.relPath], {
        content: vars.content,
        size: vars.content.length,
      });
    },
  });

  if (!sourceId || sourcesQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
      </div>
    );
  }
  if (!source || !source.path) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
        <FolderX className="h-7 w-7 opacity-60" />
        <p className="text-[13px]">
          Esta source ainda não tem pasta local (repo não clonado ou removido).
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-64 shrink-0 border-r border-hairline-soft px-1">
        <div className="flex h-9 items-center px-2 text-[12px] font-medium text-text-secondary">
          <span className="truncate">{source.label}</span>
        </div>
        <FileTree sourceId={sourceId} onOpenFile={openTab} activePath={activePath} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <EditorTabs />
        <div className="min-h-0 flex-1">
          {activePath ? (
            <CodeEditor
              sourceId={sourceId}
              relPath={activePath}
              onSave={(relPath, content) => saveMutation.mutate({ relPath, content })}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[13px] text-text-muted">
              Selecione um arquivo na árvore pra abrir.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

> **Nota:** workspace ativo vem de `useWorkspaceStore((s) => s.active)` (mesmo padrão da Sidebar, `src/renderer/src/stores/workspaceStore.ts`).

- [ ] **Step 2: Registrar a rota no router**

Em `src/renderer/src/router.tsx`, adicionar o lazy import junto dos outros (após o de `SourceDetailPage`, ~linha 40):

```typescript
const SourceCodePage = lazy(() =>
  import('@renderer/pages/SourceCodePage').then((m) => ({ default: m.SourceCodePage })),
);
```

E a rota logo após a de `/sources/:sourceId` (~linha 130):

```tsx
<Route path="/sources/:sourceId/code" element={<SourceCodePage />} />
```

- [ ] **Step 3: Verificar typecheck**

Run: `npm run typecheck`
Expected: PASS (depois de ajustar o hook de workspace, se preciso).

- [ ] **Step 4: Commit (checkpoint — só com autorização)**

```bash
git add src/renderer/src/pages/SourceCodePage.tsx src/renderer/src/router.tsx
git commit -m "feat(renderer): source code ide page + route"
```

---

## Task 10: Pontos de entrada (botão "Abrir código")

**Files:**

- Modify: `src/renderer/src/components/layout/Sidebar.tsx` (`SidebarSourceRow`, ~linha 573-595)
- Modify: `src/renderer/src/pages/SourceDetailPage.tsx`

- [ ] **Step 1: Botão no hover da linha do source (Sidebar)**

A linha hoje é um `<NavLink to={/sources/:id}>`. Não dá pra aninhar `<button>` clicável dentro do NavLink sem `stopPropagation`. Adicionar, logo antes do fechamento do conteúdo do NavLink (depois do nome do source, dentro do `<NavLink>`), um ícone que navega pro `/code`:

Importar no topo do arquivo (junto dos outros ícones lucide): `Code2`. E `useNavigate` de `react-router-dom`.

Dentro de `SidebarSourceRow`, antes do `return`:

```typescript
const navigate = useNavigate();
```

E dentro do `<NavLink>`, como último filho (após o `<span>` do nome / badge):

```tsx
<button
  type="button"
  onClick={(e) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`/sources/${s.id}/code`);
  }}
  className="ml-auto grid h-5 w-5 shrink-0 place-items-center rounded text-text-faint opacity-0 transition-opacity hover:bg-surface-strong hover:text-text-primary group-hover:opacity-100"
  title="Abrir código"
  aria-label="Abrir código"
>
  <Code2 className="h-3.5 w-3.5" />
</button>
```

> Se já existir um `ml-auto` no badge de git count, trocar este por `ml-1` pra não brigar pelo espaço — ajustar visualmente no `npm run dev`.

- [ ] **Step 2: Botão na SourceDetailPage**

Abrir `src/renderer/src/pages/SourceDetailPage.tsx`, localizar o cabeçalho/área de ações da página (onde ficam botões tipo "Configurar"/"Remover" — `grep -n "button\|<header\|actions" src/renderer/src/pages/SourceDetailPage.tsx`). Adicionar um botão primário que navega pro code:

Importar `Code2` (lucide) e garantir `useNavigate`/`Link`. Adicionar:

```tsx
<Link
  to={`/sources/${source.id}/code`}
  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-colors hover:opacity-90"
>
  <Code2 className="h-3.5 w-3.5" />
  Abrir código
</Link>
```

(Usar o mesmo padrão de botão primário já presente na página, se houver — reusar classe/componente existente em vez de hardcodar. `grep` por botões na própria página primeiro.)

- [ ] **Step 3: Verificar typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit (checkpoint — só com autorização)**

```bash
git add src/renderer/src/components/layout/Sidebar.tsx src/renderer/src/pages/SourceDetailPage.tsx
git commit -m "feat(renderer): entry points to open source code ide"
```

---

## Task 11: Verificação final (manual, sem test runner)

**Files:** nenhum (validação).

- [ ] **Step 1: Typecheck limpo do projeto inteiro**

Run: `npm run typecheck`
Expected: PASS, zero erros.

- [ ] **Step 2: Lint dos arquivos tocados (se houver script de lint)**

Run: `npm run lint` (ou `npx eslint <arquivos novos/modificados>`)
Expected: sem erro. Husky pode bloquear commit se sujo.

- [ ] **Step 3: Rodar o app e validar o fluxo**

Run: `npm run dev`

Checklist manual:

- Clicar no ícone "Abrir código" de uma source na sidebar → abre `/sources/:id/code`.
- Árvore mostra a raiz; expandir pasta carrega filhos (pasta dentro de pasta funciona).
- Abrir um `.tsx` → cores de sintaxe seguindo o tema ativo.
- Abrir um `.env` → aparece na árvore e abre como texto.
- Abrir arquivo grande (>2MB) ou binário (uma imagem) → placeholder "preview não disponível".
- Editar um arquivo → bolinha de dirty na aba.
- `Cmd+S` (macOS) → salva; bolinha some; reabrir o arquivo confirma persistência no disco.
- Abrir 2-3 arquivos → várias abas; fechar aba suja pede confirmação.
- Trocar o tema do app em Settings → cores do editor mudam.
- Source sem path (repo não clonado) → estado vazio explicativo, sem crash.

- [ ] **Step 4: Atualizar o spec com a correção da rota**

Em `docs/superpowers/specs/2026-06-14-embedded-code-ide-design.md`, trocar `/source/:sourceId/code` por `/sources/:sourceId/code` (plural, consistente com a rota existente).

- [ ] **Step 5: Commit final (checkpoint — só com autorização)**

```bash
git add -A
git commit -m "docs: fix route path in code ide spec"
```

---

## Self-review (cobertura do spec)

- Formato página dedicada + rota → Task 9. ✓
- Botão por source (sidebar + SourceDetailPage) → Task 10. ✓
- Árvore lazy (1 nível por expansão) → Task 6 (`enabled: open`). ✓
- Motor CodeMirror 6 → Tasks 1, 7. ✓
- Tema derivado de `CodeThemeColors`, reage a troca → Task 5 + `useActiveCodeColors` na Task 7. ✓
- Salvar explícito Cmd+S, sem autosave → Task 7 (`Mod-s` keymap). ✓
- Dirty + confirmação ao fechar → Tasks 4, 8. ✓
- Abas, escopo da source, reset ao trocar → Tasks 4, 9 (`useEffect` reset). ✓
- `.env` como texto, sem máscara → Task 3 (read-dir deixa `.env` visível) + Task 5 (sem lang = só tema). ✓
- Binário / >2MB placeholder → Task 3 (`looksBinary`/`MAX_FILE_BYTES`) + Task 7. ✓
- Guarda anti path-traversal nos 3 IPCs → Task 3 (`resolveInsideSource`). ✓
- 1 dep nova (CodeMirror) → Task 1. ✓
- Erros (source sem path, read/write falha) → Tasks 7, 9. ✓
