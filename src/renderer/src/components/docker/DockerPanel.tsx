import { useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDockerStore } from '@renderer/stores/dockerStore';
import { PageShell } from '@renderer/components/layout/PageShell';
import { ContainerList } from './ContainerList';
import { ContainerDetail } from './ContainerDetail';
import { EngineSetup } from './EngineSetup';
import { VolumesView } from './VolumesView';
import { ImagesView } from './ImagesView';
import { NetworksView } from './NetworksView';
import { ActivityMonitorView } from './ActivityMonitorView';

const VIEW_TITLE: Record<string, string> = {
  containers: 'Containers',
  volumes: 'Volumes',
  images: 'Images',
  networks: 'Networks',
  activity: 'Activity Monitor',
};

export function DockerPanel() {
  const engine = useDockerStore((s) => s.engine);
  const view = useDockerStore((s) => s.view);
  const setEngine = useDockerStore((s) => s.setEngine);
  const setContainers = useDockerStore((s) => s.setContainers);
  const containers = useDockerStore((s) => s.containers);
  const selectedId = useDockerStore((s) => s.selectedId);
  const select = useDockerStore((s) => s.select);

  // Ping do engine ao montar. `reping` revalida após o usuário subir o engine.
  const reping = useCallback(() => {
    window.orkestral['docker:ping']()
      .then((r) => setEngine(r.status, r.message))
      .catch(() => setEngine('error'));
  }, [setEngine]);

  useEffect(reping, [reping]);

  // Lista de containers (refetch periódico leve + on containers-changed).
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

  if (engine === 'no-engine' || engine === 'error') {
    return (
      <PageShell title="Docker" contentClassName="overflow-hidden">
        <EngineSetup onReady={reping} />
      </PageShell>
    );
  }

  return (
    <PageShell title={VIEW_TITLE[view] ?? 'Docker'} contentClassName="overflow-hidden">
      {view === 'containers' && (
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
      )}
      {view === 'volumes' && <VolumesView />}
      {view === 'images' && <ImagesView />}
      {view === 'networks' && <NetworksView />}
      {view === 'activity' && <ActivityMonitorView />}
    </PageShell>
  );
}
