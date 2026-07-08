import { useState } from 'react';
import { Check } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Agent, MarketplaceCatalogItem } from '@shared/types';
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog';
import { Button } from '@renderer/components/ui/button';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { scopeFor, scopeLabel } from './shared';
import { toast } from '@renderer/stores/toastStore';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';

interface AssignAgentsDialogProps {
  /** Item do catálogo a instalar. Null = fechado. O install acontece no "Instalar". */
  item: MarketplaceCatalogItem | null;
  /** Credenciais/env coletadas no detalhe (MCP). Default {}. */
  env?: Record<string, string>;
  workspaceId: string;
  open: boolean;
  /** Fecha SEM instalar (cancelar / X / Esc). */
  onClose: () => void;
  /** Chamado após instalar com sucesso — pra refetch/cleanup no chamador. */
  onInstalled?: () => void;
}

export function AssignAgentsDialog({
  item,
  env,
  workspaceId,
  open,
  onClose,
  onInstalled,
}: AssignAgentsDialogProps) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const isMcp = item?.kind === 'mcp';

  const agentsQuery = useQuery({
    queryKey: ['agents', workspaceId],
    queryFn: () => window.orkestral['agent:list']({ workspaceId }),
    enabled: open,
  });
  const agents = agentsQuery.data ?? [];

  // Default: todos marcados. Re-sincroniza quando o modal abre ou quando a lista
  // de agentes chega (async). Padrão "adjust state during render" do React —
  // evita effect+setState (cascading renders) e preserva os toggles do usuário
  // enquanto a chave de agentes não muda.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncKey, setSyncKey] = useState<string | null>(null);
  const openKey = open ? agents.map((a) => a.id).join(',') : null;
  if (openKey !== syncKey) {
    setSyncKey(openKey);
    setSelected(new Set(openKey ? openKey.split(',') : []));
  }

  function siblingsOf(agent: Agent): Agent[] {
    if (!isMcp || !agent.adapterType) return [agent];
    const scope = scopeFor(agent.adapterType, agent.model ?? null);
    return agents.filter(
      (a) => a.adapterType && scopeFor(a.adapterType, a.model ?? null) === scope,
    );
  }

  function toggle(agent: Agent): void {
    const next = new Set(selected);
    const group = siblingsOf(agent);
    const turningOn = !next.has(agent.id);
    for (const g of group) {
      if (turningOn) next.add(g.id);
      else next.delete(g.id);
    }
    setSelected(next);
  }

  const allSelected = agents.length > 0 && selected.size === agents.length;
  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(agents.map((a) => a.id)));
  }

  /** Scopes de MCP a partir dos agentes escolhidos. Todos → `['*']`. */
  function scopesFor(targets: Agent[]): string[] {
    if (targets.length === agents.length) return ['*'];
    return Array.from(
      new Set(
        targets.filter((a) => a.adapterType).map((a) => scopeFor(a.adapterType!, a.model ?? null)),
      ),
    );
  }

  const installMut = useMutation({
    mutationFn: async () => {
      if (!item) return;
      const chosen = agents.filter((a) => selected.has(a.id));
      // Instala AGORA (no clique em Instalar), não na abertura do modal.
      const created = await window.orkestral['marketplace:install']({
        workspaceId,
        item,
        env: env && Object.keys(env).length > 0 ? env : undefined,
        modelScopes: isMcp ? scopesFor(chosen) : undefined,
      });
      // Skills de instrução ligam por agente (attach). MCP já entrou via scope.
      if (!isMcp) {
        for (const a of chosen) {
          await window.orkestral['skill:attach']({ agentId: a.id, skillId: created.id });
        }
      }
    },
    onSuccess: () => {
      if (item)
        toast.success(
          t('pages.marketplace.installedToastTitle', { name: item.name }),
          isMcp
            ? t('pages.marketplace.installedMcpDesc')
            : t('pages.marketplace.installedSkillDesc'),
        );
      queryClient.invalidateQueries({ queryKey: ['skills', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      for (const a of agents)
        queryClient.invalidateQueries({ queryKey: ['skills-by-agent', a.id] });
      onInstalled?.();
      onClose();
    },
    onError: (e) =>
      toast.error(
        t('pages.marketplace.installFailTitle'),
        e instanceof Error ? e.message : undefined,
      ),
  });

  if (!item) return null;

  const subtitle = isMcp
    ? t('pages.marketplace.assignSubtitleMcp')
    : t('pages.marketplace.assignSubtitleSkill');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !installMut.isPending && onClose()}>
      <DialogContent className="max-w-2xl">
        <div className="flex flex-col gap-1 px-6 pb-4 pt-6">
          <DialogTitle className="pr-8 text-[17px] font-semibold leading-tight text-text-primary">
            {t('pages.marketplace.assignTitle', { name: item.name })}
          </DialogTitle>
          <p className="text-[13px] leading-snug text-text-muted">{subtitle}</p>
        </div>

        {agents.length === 0 ? (
          <p className="px-6 pb-10 pt-2 text-center text-sm text-text-muted">
            {t('pages.marketplace.assignEmpty')}
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 px-6 pb-3">
              <span className="text-xs font-medium text-text-muted">
                {t('pages.marketplace.assignCounter', {
                  selected: selected.size,
                  total: agents.length,
                })}
              </span>
              <Button variant="outline" size="sm" onClick={toggleAll}>
                {allSelected
                  ? t('pages.marketplace.assignDeselectAll')
                  : t('pages.marketplace.assignSelectAll')}
              </Button>
            </div>

            <div
              className="grid gap-2 overflow-y-auto px-6"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                maxHeight: '50vh',
              }}
            >
              {agents.map((agent) => {
                const on = selected.has(agent.id);
                const meta = [
                  agent.title || agent.role,
                  agent.adapterType
                    ? scopeLabel(scopeFor(agent.adapterType, agent.model ?? null), t)
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => toggle(agent)}
                    aria-pressed={on}
                    className={cn(
                      'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
                      {
                        'border-accent-purple/50 bg-accent-purple/[0.08]': on,
                        'border-border bg-surface hover:bg-surface-elevated': !on,
                      },
                    )}
                  >
                    <AgentAvatar
                      seed={agent.avatarSeed}
                      name={agent.name}
                      size={38}
                      rounded="full"
                      className={cn(on && 'ring-2 ring-accent-purple/60')}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-text-primary">
                        {agent.name}
                      </div>
                      <div className="truncate text-[11.5px] text-text-muted">{meta}</div>
                    </div>
                    <span
                      className={cn(
                        'grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors',
                        on
                          ? 'border-accent-purple bg-accent-purple text-white'
                          : 'border-border text-transparent',
                      )}
                    >
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </span>
                  </button>
                );
              })}
            </div>

            {isMcp && (
              <p className="px-6 pt-3 text-[11.5px] leading-snug text-text-muted">
                {t('pages.marketplace.assignSiblingNote')}
              </p>
            )}
          </>
        )}

        <div className="mt-4 flex justify-end gap-2 border-t border-hairline px-6 py-4">
          <Button variant="ghost" onClick={onClose} disabled={installMut.isPending}>
            {t('pages.marketplace.assignCancel')}
          </Button>
          <Button onClick={() => installMut.mutate()} disabled={installMut.isPending}>
            {t('pages.marketplace.assignInstall')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
