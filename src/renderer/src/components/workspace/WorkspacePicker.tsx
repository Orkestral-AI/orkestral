import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { WorkspaceAvatar } from '@renderer/components/layout/WorkspaceAvatar';
import { useT } from '@renderer/i18n';
import { cn } from '@renderer/lib/utils';
import type { Workspace } from '@shared/types';

interface WorkspacePickerProps {
  /** Id do workspace selecionado. */
  value: string | null | undefined;
  /** Chamado ao escolher um workspace (objeto completo). */
  onChange: (workspace: Workspace) => void;
  /** Alinhamento do popover em relação ao gatilho. */
  align?: 'start' | 'end';
  className?: string;
}

/**
 * Seletor de workspace reutilizável e CONTROLADO. Mostra o workspace atual e
 * permite trocar via popover — sem mexer no estado global por conta própria.
 * Quem consome decide o que fazer no `onChange` (filtrar uma view local,
 * trocar o workspace ativo, etc.). Reusa WorkspaceAvatar/Popover.
 */
export function WorkspacePicker({
  value,
  onChange,
  align = 'end',
  className,
}: WorkspacePickerProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => window.orkestral['workspace:list'](),
  });
  const list = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);
  const selected = list.find((w) => w.id === value) ?? null;

  function handlePick(ws: Workspace) {
    setOpen(false);
    if (ws.id !== value) onChange(ws);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface/40 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover',
            className,
          )}
        >
          <WorkspaceAvatar workspace={selected} size="sm" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
            {selected?.name ?? t('layout.workspace.fallbackName')}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} sideOffset={6} className="w-[240px] p-1">
        <div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-text-faint">
          {t('layout.workspace.switch')}
        </div>
        <div className="flex flex-col">
          {list.map((ws) => {
            const isActive = ws.id === value;
            return (
              <button
                key={ws.id}
                type="button"
                onClick={() => handlePick(ws)}
                className={cn(
                  'flex items-center gap-2.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-surface-active',
                  isActive && 'bg-surface-hover',
                )}
              >
                <WorkspaceAvatar workspace={ws} size="sm" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">
                  {ws.name}
                </span>
                {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-text-primary" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
