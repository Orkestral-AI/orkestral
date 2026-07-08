import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import type { Agent } from '@shared/types';

interface TreeNode {
  agent: Agent;
  children: TreeNode[];
  depth: number;
}

function buildTree(agents: Agent[]): TreeNode[] {
  const byParent = new Map<string | null, Agent[]>();
  for (const a of agents) {
    const p = a.reportsTo ?? null;
    const list = byParent.get(p) ?? [];
    list.push(a);
    byParent.set(p, list);
  }
  function build(parent: string | null, depth: number): TreeNode[] {
    const list = byParent.get(parent) ?? [];
    return list.map((a) => ({
      agent: a,
      children: build(a.id, depth + 1),
      depth,
    }));
  }
  return build(null, 0);
}

export function OrgPage() {
  const { t } = useT();
  const activeWorkspace = useWorkspaceStore((s) => s.active);
  const navigate = useNavigate();

  const agentsQuery = useQuery({
    queryKey: ['agents', activeWorkspace?.id],
    enabled: !!activeWorkspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: activeWorkspace!.id }),
  });
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);

  const tree = useMemo(() => buildTree(agents), [agents]);

  return (
    <PageShell title={t('workspace.org.title')} description={t('workspace.org.description')}>
      {!activeWorkspace ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('workspace.org.noWorkspace')}
        </div>
      ) : agentsQuery.isPending ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('workspace.org.loading')}
        </div>
      ) : agentsQuery.isError ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-accent-red">
          {t('workspace.org.loadError')}
        </div>
      ) : agents.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-muted">
          {t('workspace.org.noAgents')}
        </div>
      ) : (
        <div className="thin-scrollbar flex-1 overflow-y-auto px-8 py-6">
          <div className="flex flex-col gap-1">
            {tree.map((node) => (
              <TreeBranch
                key={node.agent.id}
                node={node}
                onClick={(id) => navigate(`/agents/${id}`)}
              />
            ))}
          </div>
        </div>
      )}
    </PageShell>
  );
}

function TreeBranch({ node, onClick }: { node: TreeNode; onClick: (agentId: string) => void }) {
  const a = node.agent;
  return (
    <>
      <button
        type="button"
        onClick={() => onClick(a.id)}
        className="group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-hover"
        style={{ paddingLeft: 8 + node.depth * 28 }}
      >
        {/* connector dots */}
        {node.depth > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-faint" />}
        <AgentAvatar seed={a.avatarSeed} name={a.name} size={28} rounded="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-text-primary">{a.name}</span>
            {a.isOrchestrator && (
              <span className="rounded-full border border-hairline-strong bg-surface-hover px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-text-secondary">
                CEO
              </span>
            )}
            <span
              className={cn(
                'inline-flex h-1.5 w-1.5 rounded-full',
                a.status === 'live' && 'bg-accent-green animate-pulse-dot',
                a.status === 'paused' && 'bg-accent-yellow',
                a.status === 'error' && 'bg-accent-red',
                a.status === 'idle' && 'bg-text-muted',
              )}
            />
          </div>
          {(a.title || a.role) && (
            <div className="truncate text-[10.5px] text-text-muted">{a.title || a.role}</div>
          )}
        </div>
        {node.children.length > 0 && (
          <span className="rounded-md bg-surface-1 px-1.5 py-0.5 text-[10.5px] text-text-muted">
            {node.children.length}
          </span>
        )}
      </button>
      {node.children.map((c) => (
        <TreeBranch key={c.agent.id} node={c} onClick={onClick} />
      ))}
    </>
  );
}

function PageShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <div className="window-drag border-b border-hairline-soft px-8 py-5">
          <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">{title}</h1>
          <p className="mt-0.5 text-[12.5px] text-text-muted">{description}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
