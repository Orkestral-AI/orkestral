import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Network, Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { TwoPane, EmptyDetail, InfoScroll, Card, Row, Section, KVTable } from './DockerKit';
import { fmtDate } from '@renderer/lib/dockerFormat';
import { hashColor } from '@renderer/lib/dockerImageIcon';

export function NetworksView() {
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['docker-networks'],
    queryFn: () => window.orkestral['docker:list-networks'](),
    refetchInterval: 5000,
  });
  const networks = data?.networks ?? [];
  const sel = networks.find((n) => n.id === selected);

  return (
    <TwoPane
      list={
        isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="shrink-0 border-b border-hairline-faint px-3 py-2 text-[11px] text-text-muted">
              {networks.length} networks
            </div>
            <div className="flex flex-col gap-0.5 p-2">
              {networks.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setSelected(n.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left',
                    selected === n.id ? 'bg-surface-elevated' : 'hover:bg-surface-elevated',
                  )}
                >
                  <Network className="h-5 w-5 shrink-0" style={{ color: hashColor(n.name) }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-text-primary">{n.name}</span>
                    <span className="block truncate text-[11px] text-text-muted">
                      {n.subnet || n.driver}
                    </span>
                  </span>
                </button>
              ))}
              {networks.length === 0 && (
                <p className="px-2 py-4 text-[12px] text-text-faint">Nenhuma network.</p>
              )}
            </div>
          </div>
        )
      }
      detail={
        sel ? (
          <InfoScroll>
            <Card>
              <Row label="Name" value={sel.name} mono />
              <Row label="ID" value={sel.id} mono divider />
              {sel.created && <Row label="Created" value={fmtDate(sel.created)} divider />}
              {sel.subnet && <Row label="Subnet" value={sel.subnet} mono divider />}
              {sel.gateway && <Row label="Gateway" value={sel.gateway} mono divider />}
            </Card>
            <Card>
              <Row label="Driver" value={sel.driver || '—'} />
              <Row label="Scope" value={sel.scope || '—'} divider />
            </Card>
            {Object.keys(sel.labels).length > 0 && (
              <Section title="Labels">
                <KVTable rows={Object.entries(sel.labels)} />
              </Section>
            )}
          </InfoScroll>
        ) : (
          <EmptyDetail label="Selecione uma network" />
        )
      }
    />
  );
}
