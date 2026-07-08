import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';
import type { Issue, ExecutionCheckbox, Agent } from '@shared/types';

/**
 * Tasks da issue: checklist de uma issue com plano de execução (metadata `execution-plan`).
 * Reduz a quantidade de issues (poucas issues, cada uma com várias tasks). Cada task tem um
 * checkbox REDONDO, um responsável (avatar) e marca AO VIVO conforme a execução avança
 * (broadcast -> invalida a query). O usuário também marca/desmarca e troca o responsável.
 */
export function IssueTasks({
  issue,
  agents,
}: {
  issue: Issue;
  agents: Agent[];
}): React.ReactElement | null {
  const { t } = useT();
  const queryClient = useQueryClient();
  const meta = issue.metadata as { kind?: string; checkboxes?: ExecutionCheckbox[] } | null;
  const checkboxes = meta?.kind === 'execution-plan' ? (meta.checkboxes ?? []) : [];

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['issue-by-key'] });
  };
  const toggle = useMutation({
    mutationFn: (vars: { checkboxId: string; status: ExecutionCheckbox['status'] }) =>
      window.orkestral['issue:complete-checkbox']({ issueId: issue.id, ...vars }),
    onSuccess: invalidate,
  });
  const assign = useMutation({
    mutationFn: (vars: { checkboxId: string; agentId: string | null }) =>
      window.orkestral['issue:update-checkbox-assignee']({ issueId: issue.id, ...vars }),
    onSuccess: invalidate,
  });

  if (checkboxes.length === 0) return null;
  const done = checkboxes.filter((c) => c.status === 'done').length;
  // `icon` (não `node`) é o que o DSSelect renderiza no trigger → o avatar aparece colapsado.
  const agentOptions = [
    { value: '', label: t('issues.tasks.unassigned'), muted: true },
    ...agents.map((a) => ({
      value: a.id,
      label: a.name,
      icon: <AgentAvatar seed={a.avatarSeed} name={a.name} size={18} />,
    })),
  ];

  return (
    <div className="rounded-xl border border-border bg-surface-subtle p-2.5">
      <div className="mb-2 flex items-center justify-between px-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-faint">
          {t('issues.tasks.title')}
        </span>
        <span className="text-[11px] tabular-nums text-text-muted">
          {done}/{checkboxes.length}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {checkboxes.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-2.5 rounded-lg bg-surface px-2.5 py-1.5 transition-colors hover:bg-surface-elevated"
          >
            {/* Checkbox REDONDO refinado */}
            <button
              type="button"
              disabled={toggle.isPending}
              onClick={() =>
                toggle.mutate({
                  checkboxId: c.id,
                  status: c.status === 'done' ? 'pending' : 'done',
                })
              }
              className={cn(
                'grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border transition-colors',
                {
                  'border-accent-green bg-accent-green text-white': c.status === 'done',
                  'border-accent-yellow/60 text-accent-yellow': c.status === 'blocked',
                  'border-border-strong hover:border-accent': c.status === 'pending',
                },
              )}
              aria-label={c.instruction}
            >
              {c.status === 'done' && <Check className="h-3 w-3" strokeWidth={3} />}
              {c.status === 'blocked' && <Minus className="h-3 w-3" strokeWidth={3} />}
            </button>
            <span
              className={cn('min-w-0 flex-1 text-[12.5px] leading-snug', {
                'text-text-muted line-through': c.status === 'done',
                'text-text-secondary': c.status === 'blocked',
                'text-text-primary': c.status === 'pending',
              })}
            >
              {c.instruction}
              {c.status === 'blocked' && (
                <span className="ml-1.5 text-[10.5px] text-text-muted">
                  {t('issues.tasks.blocked')}
                </span>
              )}
            </span>
            {/* Responsável: avatar + nome, largura fixa pra não esmagar o texto */}
            <div className="w-28 shrink-0">
              <DSSelect
                inline
                value={c.assigneeAgentId ?? ''}
                onChange={(v) => assign.mutate({ checkboxId: c.id, agentId: v || null })}
                options={agentOptions}
                placeholder={t('issues.tasks.assign')}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
