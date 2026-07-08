import { useState, type ReactNode, type MouseEvent, type KeyboardEvent } from 'react';
import { groupByCompose, type DockerContainer } from '@renderer/lib/dockerGrouping';
import { dockerImageIcon } from '@renderer/lib/dockerImageIcon';
import { cn } from '@renderer/lib/utils';
import { toast } from '@renderer/stores/toastStore';
import { ChevronRight, ChevronDown, Layers, Play, Square, Trash2 } from 'lucide-react';

type Action = 'start' | 'stop' | 'restart' | 'remove';

function statusDot(state: string): string {
  if (state === 'running') return 'bg-accent-green';
  if (state === 'paused' || state === 'restarting') return 'bg-accent-yellow';
  return 'bg-accent-red';
}

async function runAction(id: string, action: Action): Promise<boolean> {
  try {
    await window.orkestral['docker:container-action']({ id, action });
    return true;
  } catch (e) {
    toast.error('Falha na ação', e instanceof Error ? e.message : undefined);
    return false;
  }
}

/** Botãozinho de ação numa linha/header (play/stop/trash). */
function RowAction({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: (e: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'grid h-6 w-6 shrink-0 place-items-center rounded transition-colors hover:bg-surface-hover',
        danger
          ? 'text-text-muted hover:text-accent-red'
          : 'text-text-secondary hover:text-text-primary',
      )}
    >
      {children}
    </button>
  );
}

export function ContainerList({
  containers,
  selectedId,
  onSelect,
}: {
  containers: DockerContainer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const groups = groupByCompose(containers);
  // "Vem tudo minimizado": começa tudo colapsado. `expanded` guarda os abertos.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const keyFor = (project: string | null): string => project ?? '__loose__';
  const toggle = (k: string): void =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  async function projectAction(
    items: DockerContainer[],
    action: 'start' | 'stop' | 'remove',
  ): Promise<void> {
    const targets =
      action === 'start'
        ? items.filter((c) => c.state !== 'running')
        : action === 'stop'
          ? items.filter((c) => c.state === 'running')
          : items;
    if (targets.length === 0) return;
    if (action === 'remove' && !window.confirm('Remover todos os containers deste projeto?')) {
      return;
    }
    const results = await Promise.all(targets.map((c) => runAction(c.id, action)));
    const ok = results.filter(Boolean).length;
    if (ok > 0) toast.success(`Projeto: ${action} (${ok}/${targets.length})`);
  }

  function onRowKey(e: KeyboardEvent, id: string): void {
    if (e.key === 'Enter') onSelect(id);
    else if (e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    }
  }

  return (
    <div className="flex flex-col gap-0.5 p-2">
      {groups.map((g) => {
        const k = keyFor(g.project);
        const open = expanded.has(k);
        const anyRunning = g.containers.some((c) => c.state === 'running');
        return (
          <div key={k}>
            {/* Header do projeto compose — chevron + nome + ações da stack inteira. */}
            <div className="group flex items-center gap-1 rounded-md px-1.5 py-1.5 hover:bg-surface-elevated">
              <button
                type="button"
                onClick={() => toggle(k)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              >
                {open ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                )}
                {/* Verde = stack com algo rodando; vermelho = tudo parado (estilo OrbStack). */}
                <Layers
                  className={cn(
                    'h-4 w-4 shrink-0',
                    anyRunning ? 'text-accent-green' : 'text-accent-red',
                  )}
                />
                <span className="truncate text-[13px] font-medium text-text-primary">
                  {g.project ?? 'Avulsos'}
                </span>
                <span className="shrink-0 text-[11px] text-text-faint">{g.containers.length}</span>
              </button>
              <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <RowAction
                  title={anyRunning ? 'Parar stack' : 'Subir stack'}
                  onClick={() => projectAction(g.containers, anyRunning ? 'stop' : 'start')}
                >
                  {anyRunning ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </RowAction>
                <RowAction
                  title="Remover stack"
                  danger
                  onClick={() => projectAction(g.containers, 'remove')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </RowAction>
              </div>
            </div>

            {/* Containers do projeto (só quando expandido). */}
            {open &&
              g.containers.map((c) => {
                const { Icon, color } = dockerImageIcon(c.image);
                const running = c.state === 'running';
                const label = c.labels['com.docker.compose.service'] ?? c.name;
                return (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(c.id)}
                    onKeyDown={(e) => onRowKey(e, c.id)}
                    className={cn(
                      'group flex w-full cursor-pointer items-center gap-2.5 rounded-md py-1.5 pl-7 pr-1.5 text-left',
                      { 'bg-surface-elevated': selectedId === c.id },
                      { 'hover:bg-surface-elevated': selectedId !== c.id },
                    )}
                  >
                    <span className="relative shrink-0">
                      <Icon className="h-5 w-5" style={{ color }} />
                      <span
                        className={cn(
                          'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-background',
                          statusDot(c.state),
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] text-text-primary">{label}</span>
                        {c.engine && (
                          <span className="shrink-0 rounded bg-surface-2 px-1.5 py-px text-[9.5px] font-medium text-text-muted">
                            {c.engine}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] text-text-muted">{c.image}</span>
                    </span>
                    <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <RowAction
                        title={running ? 'Parar' : 'Iniciar'}
                        onClick={(e) => {
                          e.stopPropagation();
                          void runAction(c.id, running ? 'stop' : 'start');
                        }}
                      >
                        {running ? (
                          <Square className="h-3.5 w-3.5" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                      </RowAction>
                      <RowAction
                        title="Remover"
                        danger
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm('Remover este container?'))
                            void runAction(c.id, 'remove');
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </RowAction>
                    </span>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
