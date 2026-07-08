import { useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, keymap } from '@codemirror/view';
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  setSearchQuery,
  openSearchPanel,
} from '@codemirror/search';
import {
  createEditorFindPanel,
  getPersistedFindOpen,
  persistedSearchQuery,
} from './editorFindPanel';
import { Loader2, FileWarning } from 'lucide-react';
import { useSettingsStore } from '@renderer/stores/settingsStore';
import { getCodeTheme } from '@renderer/lib/codeThemes';
import { buildCmTheme, languageForPath } from '@renderer/lib/cmTheme';
import { useCodeTabsStore } from '@renderer/stores/codeTabsStore';
import { useCodeIdeStore } from '@renderer/stores/codeIdeStore';

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
  onSave: (sourceId: string, relPath: string, content: string) => void;
}) {
  const colors = useActiveCodeColors();
  const setDraft = useCodeTabsStore((s) => s.setDraft);
  const tab = useCodeTabsStore((s) =>
    s.tabs.find((t) => t.sourceId === sourceId && t.relPath === relPath),
  );
  const viewRef = useRef<EditorView | null>(null);
  const goTo = useCodeIdeStore((s) => s.goTo);
  const clearGoTo = useCodeIdeStore((s) => s.clearGoTo);

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
          onSave(sourceId, relPath, view.state.doc.toString());
          return true;
        },
      },
    ]);
    return [
      buildCmTheme(colors),
      EditorView.lineWrapping,
      // Busca/substituição DENTRO do arquivo (Cmd+F) — widget flutuante no topo,
      // estilo VS Code. Separado da busca global da sidebar (Cmd+Shift+F).
      search({ top: true, createPanel: createEditorFindPanel }),
      highlightSelectionMatches(),
      // Tira o Mod-f do keymap do CodeMirror — quem abre é o atalho global da página
      // (open único, sem double-trigger). O resto (find next/prev) continua.
      keymap.of(searchKeymap.filter((b) => b.key !== 'Mod-f')),
      saveKey,
      ...(lang ? [lang] : []),
    ];
  }, [colors, sourceId, relPath, onSave]);

  const handleChange = useCallback(
    (value: string) => setDraft(sourceId, relPath, value),
    [sourceId, relPath, setDraft],
  );

  const jumpToLine = useCallback(
    (view: EditorView, lineNum: number) => {
      const ln = Math.min(Math.max(lineNum, 1), view.state.doc.lines);
      const line = view.state.doc.line(ln);
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      view.focus();
      clearGoTo();
    },
    [clearGoTo],
  );

  // Arquivo já aberto: o goTo muda e o editor já existe → pula aqui. Arquivo ainda
  // não aberto: o editor só monta após o load, então o pulo é feito no onCreateEditor.
  useEffect(() => {
    if (goTo?.sourceId === sourceId && goTo.relPath === relPath && viewRef.current)
      jumpToLine(viewRef.current, goTo.line);
  }, [goTo, sourceId, relPath, jumpToLine]);

  if (fileQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
      </div>
    );
  }
  const data = fileQuery.data;
  if (!data || fileQuery.isError) {
    return <EditorPlaceholder label="Não foi possível ler este arquivo." />;
  }
  if ('binary' in data && data.binary) {
    return <EditorPlaceholder label="Arquivo binário — preview não disponível." />;
  }
  if ('tooLarge' in data && data.tooLarge) {
    return (
      <EditorPlaceholder
        label={`Arquivo muito grande (${Math.round(data.size / 1024)} KB) — preview não disponível.`}
      />
    );
  }

  const value = tab?.draft ?? ('content' in data ? data.content : '');

  return (
    <div className="h-full overflow-hidden bg-background">
      <CodeMirror
        value={value}
        height="100%"
        style={{ height: '100%' }}
        theme="none"
        extensions={extensions}
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
        onChange={handleChange}
        onCreateEditor={(view) => {
          viewRef.current = view;
          const pending = useCodeIdeStore.getState().goTo;
          const jumping = pending?.sourceId === sourceId && pending.relPath === relPath;
          if (jumping) jumpToLine(view, pending!.line);
          // Restaura a busca do arquivo anterior (termo + flags) e reabre o widget
          // se estava aberto — igual VS Code, o find segue ao trocar de arquivo.
          // No rAF (view já no DOM) e só se ela ainda estiver montada.
          requestAnimationFrame(() => {
            if (!view.dom.isConnected) return;
            const fq = persistedSearchQuery();
            if (fq) view.dispatch({ effects: setSearchQuery.of(fq) });
            if (getPersistedFindOpen() && !jumping) openSearchPanel(view);
          });
        }}
      />
    </div>
  );
}

function EditorPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
      <FileWarning className="h-6 w-6 opacity-60" />
      <p className="text-[13px]">{label}</p>
    </div>
  );
}
