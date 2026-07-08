import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Bot, Check, Plus, Star, Trash2 } from 'lucide-react';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { TopToolbar } from '@renderer/components/chat/TopToolbar';
import { ConfirmDialog } from '@renderer/components/ui';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { useUIStore } from '@renderer/stores/uiStore';
import { ProviderIcon, providerLabel } from '@renderer/components/ProviderIcon';
import { useT, type TFunction } from '@renderer/i18n';
import type { Agent } from '@shared/types';

/**
 * Lista de agentes do workspace. Cards mostram nome, role, adapter+model,
 * capacidades. CTA "Novo agente" abre o modal.
 */
export function AgentsPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const workspace = useWorkspaceStore((s) => s.active);
  const queryClient = useQueryClient();
  const openNewAgent = useUIStore((s) => s.openNewAgent);
  // Agente pendente de remoção — abre o ConfirmDialog (substitui o confirm() nativo).
  const [pendingDelete, setPendingDelete] = useState<Agent | null>(null);

  const agentsQuery = useQuery({
    queryKey: ['agents', workspace?.id],
    enabled: !!workspace,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: workspace!.id }),
  });
  const agents = agentsQuery.data ?? [];

  const deleteMutation = useMutation({
    mutationFn: (agentId: string) => window.orkestral['agent:delete']({ agentId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  // Orchestrator vem primeiro
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.isOrchestrator && !b.isOrchestrator) return -1;
    if (!a.isOrchestrator && b.isOrchestrator) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="flex h-full flex-col pl-2 pr-4 pt-4 pb-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        <TopToolbar />

        <div className="no-scrollbar flex-1 overflow-y-auto px-8 pb-10 pt-6">
          <div className="mb-8 flex items-center justify-between gap-6">
            <div>
              <h1 className="text-[20px] font-medium tracking-tight text-text-primary">
                {t('agents.list.title')}
              </h1>
              <p className="mt-0.5 text-[13px] text-text-secondary">{t('agents.list.subtitle')}</p>
            </div>
            <button
              type="button"
              onClick={() => openNewAgent()}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-text-primary px-3.5 text-[13px] font-medium text-background transition-colors hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('agents.list.newAgent')}
            </button>
          </div>

          {sortedAgents.length === 0 ? (
            <EmptyState onCreate={() => openNewAgent()} t={t} />
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {sortedAgents.map((a) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  t={t}
                  onOpen={() => navigate(`/agents/${a.id}`)}
                  onDelete={() => setPendingDelete(a)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {pendingDelete !== null && (
        <ConfirmDialog
          title={t('agents.list.removeAgentTitle')}
          body={t('agents.list.removeAgentConfirm', { name: pendingDelete.name })}
          confirmLabel={t('common.remove')}
          cancelLabel={t('common.cancel')}
          variant="danger"
          busy={deleteMutation.isPending}
          onConfirm={() => {
            if (pendingDelete) deleteMutation.mutate(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

function AgentCard({
  agent,
  onOpen,
  onDelete,
  t,
}: {
  agent: Agent;
  onOpen: () => void;
  onDelete: () => void;
  t: TFunction;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group relative flex cursor-pointer flex-col gap-3 rounded-xl border border-hairline-med bg-surface-faint p-4 transition-all hover:border-hairline-bright hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface-1 text-text-primary">
          <AgentAvatar seed={agent.avatarSeed} name={agent.name} size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="truncate text-[14px] font-medium text-text-primary">{agent.name}</div>
            {agent.isOrchestrator && <Star className="h-3 w-3 shrink-0 text-accent-yellow" />}
          </div>
          {agent.title && (
            <div className="truncate text-[11.5px] text-text-muted">{agent.title}</div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag>
          <span className="inline-flex items-center gap-1">
            <ProviderIcon provider={agent.adapterType} className="h-3 w-3" />
            {providerLabel(agent.adapterType)}
          </span>
        </Tag>
        {agent.model && agent.model !== 'default' && <Tag>{agent.model}</Tag>}
        {agent.isOrchestrator && <Tag accent="green">{t('agents.list.tags.orchestrator')}</Tag>}
      </div>
      <div className="flex flex-wrap gap-1.5 text-[10.5px] text-text-muted">
        {agent.canEditFiles && <CapTag>{t('agents.list.caps.editFiles')}</CapTag>}
        {agent.canRunCommands && <CapTag>{t('agents.list.caps.runCommands')}</CapTag>}
        {agent.canCreateAgents && <CapTag>{t('agents.list.caps.createAgents')}</CapTag>}
        {agent.canAssignTasks && <CapTag>{t('agents.list.caps.assignTasks')}</CapTag>}
      </div>
      {!agent.isOrchestrator && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded text-text-muted opacity-0 transition-all hover:bg-accent-red/10 hover:text-accent-red group-hover:opacity-100"
          title={t('agents.list.remove')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function Tag({ children, accent }: { children: React.ReactNode; accent?: 'green' }) {
  return (
    <span
      className={
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-medium ' +
        (accent === 'green'
          ? 'bg-accent-green/15 text-accent-green'
          : 'bg-surface-2 text-text-secondary')
      }
    >
      {children}
    </span>
  );
}

function CapTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-text-muted">
      <Check className="h-2.5 w-2.5 text-accent-green" />
      {children}
    </span>
  );
}

function EmptyState({ onCreate, t }: { onCreate: () => void; t: TFunction }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-hairline-faint bg-surface-ghost px-6 py-16">
      <div className="grid h-12 w-12 place-items-center rounded-xl border border-hairline bg-surface-subtle">
        <Bot className="h-5 w-5 text-text-faint" />
      </div>
      <div className="text-center">
        <div className="text-[14.5px] font-medium text-text-primary">
          {t('agents.list.empty.title')}
        </div>
        <div className="mt-1 max-w-[320px] text-[12.5px] text-text-muted">
          {t('agents.list.empty.description')}
        </div>
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-md bg-text-primary px-3.5 text-[13px] font-medium text-background transition-colors hover:opacity-90"
      >
        <Plus className="h-3.5 w-3.5" />
        {t('agents.list.empty.create')}
      </button>
    </div>
  );
}
