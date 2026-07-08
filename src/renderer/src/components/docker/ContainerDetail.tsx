import { useEffect, useState } from 'react';
import { useDockerStore } from '@renderer/stores/dockerStore';
import { toast } from '@renderer/stores/toastStore';
import { cn } from '@renderer/lib/utils';
import { dockerImageIcon } from '@renderer/lib/dockerImageIcon';
import { Play, Square, RotateCw, Trash2 } from 'lucide-react';
import { DockerExecView } from './DockerExecView';
import { ContainerInfo } from './ContainerInfo';
import { ContainerStats } from './ContainerStats';
import { ContainerFiles } from './ContainerFiles';

// Nomenclatura estilo OrbStack. 'terminal' = exec; 'info' substitui o dump de inspect.
type Tab = 'info' | 'stats' | 'logs' | 'terminal' | 'files';
const TABS: Tab[] = ['info', 'stats', 'logs', 'terminal', 'files'];

function dotColor(state: string | undefined): string {
  if (state === 'running') return 'bg-accent-green';
  if (state === 'paused' || state === 'restarting') return 'bg-accent-yellow';
  return 'bg-accent-red';
}

export function ContainerDetail({ id }: { id: string }) {
  const [tab, setTab] = useState<Tab>('info');
  const container = useDockerStore((s) => s.containers.find((c) => c.id === id));
  const logs = useDockerStore((s) => s.logsById[id] ?? '');
  const appendLog = useDockerStore((s) => s.appendLog);
  const clearLog = useDockerStore((s) => s.clearLog);
  const setStats = useDockerStore((s) => s.setStats);

  // Stream de logs + stats enquanto este container está selecionado. O stats vai pro
  // store (ContainerStats lê o valor atual de lá + mantém histórico próprio).
  useEffect(() => {
    clearLog(id);
    const offLogs = window.orkestralEvents.onDockerLogsData((e) => {
      if (e.id === id) appendLog(id, e.chunk);
    });
    const offStats = window.orkestralEvents.onDockerStatsData((e) => {
      if (e.id === id) setStats(id, e);
    });
    window.orkestral['docker:logs-start']({ id }).catch(() => undefined);
    window.orkestral['docker:stats-start']({ id }).catch(() => undefined);
    return () => {
      offLogs();
      offStats();
      window.orkestral['docker:logs-stop']({ id }).catch(() => undefined);
      window.orkestral['docker:stats-stop']({ id }).catch(() => undefined);
    };
  }, [id, appendLog, clearLog, setStats]);

  async function action(act: 'start' | 'stop' | 'restart' | 'remove'): Promise<void> {
    if (act === 'remove' && !window.confirm('Remover este container? Ação irreversível.')) return;
    try {
      await window.orkestral['docker:container-action']({ id, action: act });
      toast.success(`Container: ${act} ok`);
    } catch (e) {
      toast.error('Falha na ação', e instanceof Error ? e.message : undefined);
    }
  }

  const running = container?.state === 'running';
  const { Icon, color } = dockerImageIcon(container?.image ?? '');
  const title =
    container?.labels['com.docker.compose.service'] ?? container?.name ?? id.slice(0, 12);

  return (
    <div className="flex h-full flex-col">
      {/* Header responsivo: identidade encolhe/trunca; ações + abas quebram pra
          baixo em telas estreitas (flex-wrap) em vez de cortar. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2.5">
        {/* Identidade */}
        <div className="flex min-w-[140px] flex-1 items-center gap-2">
          <span className="relative shrink-0">
            <Icon className="h-5 w-5" style={{ color }} />
            <span
              className={cn(
                'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-background',
                dotColor(container?.state),
              )}
            />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-text-primary">{title}</div>
            <div className="truncate text-[11px] text-text-muted">{container?.image}</div>
          </div>
        </div>

        {/* Ações */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => action(running ? 'stop' : 'start')}
            title={running ? 'Parar' : 'Iniciar'}
            className="rounded p-1 text-text-secondary hover:bg-surface-elevated hover:text-text-primary"
          >
            {running ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => action('restart')}
            title="Reiniciar"
            className="rounded p-1 text-text-secondary hover:bg-surface-elevated hover:text-text-primary"
          >
            <RotateCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => action('remove')}
            title="Remover"
            className="rounded p-1 text-text-muted hover:bg-surface-elevated hover:text-accent-red"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>

        {/* Abas */}
        <div className="flex shrink-0 items-center gap-3">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'text-[13px] capitalize transition-colors',
                { 'text-text-primary': t === tab },
                { 'text-text-secondary hover:text-text-primary': t !== tab },
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'info' && <ContainerInfo id={id} />}
        {tab === 'stats' && <ContainerStats key={id} id={id} />}
        {tab === 'logs' && (
          <pre className="h-full overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-text-secondary">
            {logs}
          </pre>
        )}
        {tab === 'terminal' && (
          <div className="h-full">
            <DockerExecView id={id} />
          </div>
        )}
        {tab === 'files' && <ContainerFiles key={id} id={id} />}
      </div>
    </div>
  );
}
