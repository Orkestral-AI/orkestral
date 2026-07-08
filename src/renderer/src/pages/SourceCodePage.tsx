import { useCallback, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CodeEditor } from '@renderer/components/code-ide/CodeEditor';
import { EditorTabs } from '@renderer/components/code-ide/EditorTabs';
import { EditorEmptyState } from '@renderer/components/code-ide/EditorEmptyState';
import { openSearchPanel } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { useCodeTabsStore } from '@renderer/stores/codeTabsStore';
import { useCodeIdeStore } from '@renderer/stores/codeIdeStore';

/**
 * Painel do EDITOR no workspace IDE unificado. A árvore/busca vivem no trilho 2 da
 * sidebar (WorkspaceTree); aqui fica só a barra de abas + o editor do arquivo ativo.
 * As abas são cross-source (codeTabsStore.active = {sourceId, relPath}). Os props
 * `focusedSourceId/Root` alimentam ações da barra de abas (copiar caminho, reveal).
 */
export function SourceCodeInner({
  focusedSourceId,
  focusedSourceRoot,
}: {
  focusedSourceId: string;
  focusedSourceRoot: string;
}) {
  const queryClient = useQueryClient();
  const active = useCodeTabsStore((s) => s.active);
  const markSaved = useCodeTabsStore((s) => s.markSaved);
  const setView = useCodeIdeStore((s) => s.setView);
  const bumpFocusSearch = useCodeIdeStore((s) => s.bumpFocusSearch);

  // Atalhos: Shift+Cmd+F → busca global (trilho 2); Cmd+F → find dentro do editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
      if (e.shiftKey) {
        e.preventDefault();
        setView('search');
        bumpFocusSearch();
        return;
      }
      const el = document.querySelector('.cm-editor');
      const view = el ? EditorView.findFromDOM(el as HTMLElement) : null;
      e.preventDefault();
      if (view) {
        openSearchPanel(view);
      } else {
        setView('search');
        bumpFocusSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, bumpFocusSearch]);

  const saveMutation = useMutation({
    mutationFn: (vars: { sourceId: string; relPath: string; content: string }) =>
      window.orkestral['source:write-file']({
        sourceId: vars.sourceId,
        relPath: vars.relPath,
        content: vars.content,
      }),
    onSuccess: (_res, vars) => {
      markSaved(vars.sourceId, vars.relPath);
      queryClient.setQueryData(['source-file', vars.sourceId, vars.relPath], {
        content: vars.content,
        size: vars.content.length,
      });
    },
  });

  const handleSave = useCallback(
    (tabSourceId: string, relPath: string, content: string) =>
      saveMutation.mutate({ sourceId: tabSourceId, relPath, content }),
    [saveMutation],
  );

  return (
    // min-h-0 propaga a restrição de altura do flex pai (senão o editor não encolhe quando o
    // terminal abre e o CodeMirror vaza por baixo dele). overflow-hidden clipa o editor à área.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EditorTabs sourceId={focusedSourceId} sourceRoot={focusedSourceRoot} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {active ? (
          <CodeEditor
            key={`${active.sourceId}:${active.relPath}`}
            sourceId={active.sourceId}
            relPath={active.relPath}
            onSave={handleSave}
          />
        ) : (
          <EditorEmptyState />
        )}
      </div>
    </div>
  );
}
