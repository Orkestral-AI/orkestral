import { useEffect, useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Check, ChevronDown, RefreshCw } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { useDockerStore } from '@renderer/stores/dockerStore';
import { ContainerList } from './ContainerList';
import { ContainerDetail } from './ContainerDetail';
import { EngineSetup } from './EngineSetup';
import { VolumesView } from './VolumesView';
import { ImagesView } from './ImagesView';
import { NetworksView } from './NetworksView';
import { ActivityMonitorView } from './ActivityMonitorView';

/**
 * Conteúdo do gerenciador Docker SEM shell próprio — embutido no card da seção Dev
 * (a nav Containers/Volumes/… vem do trilho 2). Mantém o ping do engine + o polling
 * da lista de containers. Renderiza a view conforme dockerStore.view.
 */
export function DockerWorkspace() {
  const engine = useDockerStore((s) => s.engine);
  const view = useDockerStore((s) => s.view);
  const setEngine = useDockerStore((s) => s.setEngine);
  const setContainers = useDockerStore((s) => s.setContainers);
  const containers = useDockerStore((s) => s.containers);
  const selectedId = useDockerStore((s) => s.selectedId);
  const select = useDockerStore((s) => s.select);

  const reping = useCallback(() => {
    window.orkestral['docker:ping']()
      .then((r) => setEngine(r.status, r.message))
      .catch(() => setEngine('error'));
  }, [setEngine]);

  useEffect(reping, [reping]);

  const refetch = useCallback(async () => {
    const r = await window.orkestral['docker:list-containers']();
    setContainers(r.containers);
  }, [setContainers]);

  useQuery({
    queryKey: ['docker-containers'],
    queryFn: async () => {
      await refetch();
      return true;
    },
    enabled: engine === 'connected',
    refetchInterval: 4000,
  });

  useEffect(() => {
    const off = window.orkestralEvents.onDockerContainersChanged(() => {
      void refetch();
    });
    return off;
  }, [refetch]);

  const queryClient = useQueryClient();
  const enginesQuery = useQuery({
    queryKey: ['docker-engines'],
    queryFn: () => window.orkestral['docker:list-engines'](),
    refetchInterval: 10_000,
  });

  const switchEngine = useCallback(
    async (socketPath: string) => {
      await window.orkestral['docker:set-engine']({ socketPath });
      reping();
      for (const key of [
        'docker-containers',
        'docker-engines',
        'docker-images',
        'docker-volumes',
        'docker-networks',
      ]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
    [queryClient, reping],
  );

  const manualRefresh = useCallback(() => {
    reping();
    void refetch();
    void enginesQuery.refetch();
  }, [reping, refetch, enginesQuery]);

  const viewContent =
    engine === 'no-engine' || engine === 'error' ? (
      <EngineSetup onReady={reping} />
    ) : view === 'containers' ? (
      <div className="grid h-full grid-cols-[300px_1fr]">
        <div className="min-h-0 overflow-y-auto border-r border-border">
          <ContainerList containers={containers} selectedId={selectedId} onSelect={select} />
        </div>
        <div className="min-h-0">
          {selectedId ? (
            <ContainerDetail id={selectedId} />
          ) : (
            <div className="grid h-full place-items-center text-sm text-text-muted">
              Selecione um container
            </div>
          )}
        </div>
      </div>
    ) : view === 'volumes' ? (
      <VolumesView />
    ) : view === 'images' ? (
      <ImagesView />
    ) : view === 'networks' ? (
      <NetworksView />
    ) : (
      <ActivityMonitorView />
    );

  return (
    <div className="flex h-full flex-col">
      <DockerToolbar
        engines={enginesQuery.data?.engines ?? []}
        onSwitch={switchEngine}
        onRefresh={manualRefresh}
      />
      <div className="min-h-0 flex-1">{viewContent}</div>
    </div>
  );
}

/**
 * Barra do Docker: seletor de ENGINE (Docker Desktop / OrbStack / Padrão / Colima)
 * + botão de sincronizar. Como cada engine é um socket separado, trocar aqui é o
 * que faz aparecer os containers do Docker Desktop quando o default é o OrbStack.
 */
function DockerToolbar({
  engines,
  onSwitch,
  onRefresh,
}: {
  engines: Array<{
    id: string;
    label: string;
    socketPath: string;
    available: boolean;
    active: boolean;
  }>;
  onSwitch: (socketPath: string) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const active = engines.find((e) => e.active);
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            title="Engine Docker (Docker Desktop, OrbStack, Colima…)"
          >
            <Boxes className="h-3.5 w-3.5" />
            <span className="max-w-[160px] truncate">{active?.label ?? 'Engine'}</span>
            <ChevronDown className="h-3 w-3 text-text-faint" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          {engines.length === 0 ? (
            <div className="px-2 py-3 text-center text-[12px] text-text-muted">
              Nenhuma engine Docker encontrada
            </div>
          ) : (
            engines.map((e) => (
              <button
                key={e.id}
                type="button"
                disabled={!e.available}
                onClick={() => {
                  onSwitch(e.socketPath);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                  e.active
                    ? 'bg-surface-active text-text-primary'
                    : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary',
                  !e.available && 'cursor-not-allowed opacity-40',
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    e.available ? 'bg-accent-green' : 'bg-text-faint',
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{e.label}</span>
                {e.active && <Check className="h-3.5 w-3.5 shrink-0 text-accent-green" />}
              </button>
            ))
          )}
        </PopoverContent>
      </Popover>
      <button
        type="button"
        onClick={onRefresh}
        title="Sincronizar novamente"
        className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
