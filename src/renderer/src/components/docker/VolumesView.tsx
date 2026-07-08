import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HardDrive, Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { TwoPane, EmptyDetail, InfoScroll, Card, Row, Section, KVTable } from './DockerKit';
import { fmtBytes, fmtDate } from '@renderer/lib/dockerFormat';
import { hashColor } from '@renderer/lib/dockerImageIcon';

export function VolumesView() {
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['docker-volumes'],
    queryFn: () => window.orkestral['docker:list-volumes'](),
    refetchInterval: 5000,
  });
  const volumes = data?.volumes ?? [];
  const sel = volumes.find((v) => v.name === selected);
  const totalBytes = volumes.reduce((s, v) => s + (v.sizeBytes > 0 ? v.sizeBytes : 0), 0);

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
              {volumes.length} volumes · {fmtBytes(totalBytes)}
            </div>
            <div className="flex flex-col gap-0.5 p-2">
              {volumes.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  onClick={() => setSelected(v.name)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left',
                    selected === v.name ? 'bg-surface-elevated' : 'hover:bg-surface-elevated',
                  )}
                >
                  <HardDrive className="h-5 w-5 shrink-0" style={{ color: hashColor(v.name) }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-text-primary">{v.name}</span>
                    <span className="block truncate text-[11px] text-text-muted">
                      {fmtBytes(v.sizeBytes)}
                    </span>
                  </span>
                </button>
              ))}
              {volumes.length === 0 && (
                <p className="px-2 py-4 text-[12px] text-text-faint">Nenhum volume.</p>
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
              <Row label="Driver" value={sel.driver} divider />
              <Row label="Size" value={fmtBytes(sel.sizeBytes)} divider />
              {sel.created && <Row label="Created" value={fmtDate(sel.created)} divider />}
              {sel.mountpoint && <Row label="Mountpoint" value={sel.mountpoint} mono divider />}
            </Card>
            {Object.keys(sel.labels).length > 0 && (
              <Section title="Labels">
                <KVTable rows={Object.entries(sel.labels)} />
              </Section>
            )}
          </InfoScroll>
        ) : (
          <EmptyDetail label="Selecione um volume" />
        )
      }
    />
  );
}
