import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Brain, Plus, Network } from 'lucide-react';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { KbGalaxyView } from '@renderer/components/knowledge/KbGalaxyView';
import { EMPTY_KB_STATS } from '@shared/types';
import { useT } from '@renderer/i18n';

export function KnowledgeGraphPage() {
  const navigate = useNavigate();
  const workspace = useWorkspaceStore((s) => s.active);
  const queryClient = useQueryClient();
  const { t } = useT();

  const graphQuery = useQuery({
    queryKey: ['kb-graph', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['kb:get-graph']({ workspaceId: workspace!.id }),
    refetchInterval: 30_000,
  });

  // Sempre que esta view monta (vindo da sidebar após criar página, por
  // exemplo), refaz a query do grafo pra refletir mudanças que ocorreram em
  // outros lugares. `invalidateQueries` + `refetch` garante estado fresco.
  useEffect(() => {
    if (!workspace) return;
    queryClient.invalidateQueries({ queryKey: ['kb-graph', workspace.id] });
    void graphQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  // Push real-time: o MCP broadcasta `issues:changed-by-mcp` com reason
  // `kb_create_page` quando um agente cria página. Invalida o grafo na hora
  // em vez de esperar o polling de 30s — UX boa quando o agente está
  // gerando 30 páginas em sequência durante uma análise de repo.
  useEffect(() => {
    if (!workspace) return;
    const unsub = window.orkestralEvents.onIssuesChanged((event) => {
      if (event.workspaceId !== workspace.id) return;
      // reasons que afetam o grafo: kb_create_page, kb_link_pages
      if (!event.reason.startsWith('kb_')) return;
      queryClient.invalidateQueries({ queryKey: ['kb-graph', workspace.id] });
      queryClient.invalidateQueries({ queryKey: ['kb-tree'] });
    });
    return unsub;
  }, [workspace, queryClient]);

  const createPage = useMutation({
    mutationFn: () =>
      window.orkestral['kb:create-page']({
        workspaceId: workspace!.id,
        title: t('knowledge.newPageTitle'),
        kind: 'doc',
      }),
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ['kb-tree'] });
      queryClient.invalidateQueries({ queryKey: ['kb-graph'] });
      navigate(`/knowledge/${page.id}`);
    },
  });

  const hasNodes = (graphQuery.data?.nodes.length ?? 0) > 0;
  const loading = graphQuery.isPending;

  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <header className="flex items-center gap-3 border-b border-border px-5 py-3">
          <Network className="h-4 w-4 text-text-secondary" />
          <h1 className="flex-1 text-[14px] font-semibold tracking-tight text-text-primary">
            {t('knowledge.title')}
          </h1>
          {graphQuery.data && hasNodes && (
            <span className="text-[11.5px] text-text-muted">
              {t('knowledge.graph.stats', {
                nodes: graphQuery.data.nodes.length,
                edges: graphQuery.data.edges.length,
              })}
            </span>
          )}
          <button
            type="button"
            onClick={() => createPage.mutate()}
            disabled={createPage.isPending || !workspace}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-1 px-2.5 text-[11.5px] font-medium text-text-secondary transition-colors hover:bg-surface-strong hover:text-text-primary disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('knowledge.graph.newPage')}
          </button>
        </header>

        {/* min-h-0 + overflow-hidden: impede o canvas de inflar a altura do
            container além da viewport — senão os cards (ancorados embaixo) ficam
            cortados e o centro h/2 cai baixo demais. */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* Galaxy SEMPRE renderiza — quando não tem nós, mostra apenas o
              buraco negro central. Vazio total nunca: o cérebro é fixo. */}
          <KbGalaxyView
            graph={graphQuery.data ?? { nodes: [], edges: [], stats: EMPTY_KB_STATS }}
            onNodeClick={(nodeId, kind) => {
              if (kind === 'page') navigate(`/knowledge/${nodeId}`);
            }}
          />
          {!hasNodes && !loading && <EmptyOverlay onCreate={() => createPage.mutate()} />}
        </div>
      </div>
    </div>
  );
}

function EmptyOverlay({ onCreate }: { onCreate: () => void }) {
  const { t } = useT();
  return (
    <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-16">
      <div className="pointer-events-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-hairline bg-background/85 px-6 py-5 text-center backdrop-blur">
        <Brain className="h-5 w-5 text-text-secondary" />
        <p className="text-[12.5px] leading-relaxed text-text-muted">
          {t('knowledge.graph.empty')}
        </p>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-1 px-3 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-surface-strong hover:text-text-primary"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('knowledge.graph.createFirstPage')}
        </button>
      </div>
    </div>
  );
}
