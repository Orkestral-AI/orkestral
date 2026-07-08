import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { dockerImageIcon } from '@renderer/lib/dockerImageIcon';
import { fmtBytes, fmtDate } from '@renderer/lib/dockerFormat';
import { TwoPane, EmptyDetail, InfoScroll, Card, Row, Section, KVTable } from './DockerKit';

function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

interface ImageInfo {
  id: string;
  tags: string;
  created: string;
  size: number;
  platform: string;
  entrypoint: string;
  cmd: string;
  workingDir: string;
  env: [string, string][];
  ports: string[];
  labels: [string, string][];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseImage(raw: string): ImageInfo | null {
  let d: any;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!d) return null;
  const cfg = d.Config ?? {};
  const env: [string, string][] = (cfg.Env ?? []).map((e: string) => {
    const i = e.indexOf('=');
    return i >= 0 ? [e.slice(0, i), e.slice(i + 1)] : [e, ''];
  });
  return {
    id: shortId(d.Id ?? ''),
    tags: (d.RepoTags ?? []).join(', ') || '—',
    created: d.Created ?? '',
    size: d.Size ?? 0,
    platform: [d.Os, d.Architecture].filter(Boolean).join('/') || '—',
    entrypoint: Array.isArray(cfg.Entrypoint) ? cfg.Entrypoint.join(' ') : (cfg.Entrypoint ?? ''),
    cmd: Array.isArray(cfg.Cmd) ? cfg.Cmd.join(' ') : (cfg.Cmd ?? ''),
    workingDir: cfg.WorkingDir ?? '',
    env,
    ports: Object.keys(cfg.ExposedPorts ?? {}),
    labels: Object.entries(cfg.Labels ?? {}),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function ImagesView() {
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['docker-images'],
    queryFn: () => window.orkestral['docker:list-images'](),
    refetchInterval: 8000,
  });
  const images = data?.images ?? [];
  const totalMb = images.reduce((s, i) => s + i.sizeMb, 0);

  const { data: inspectData } = useQuery({
    queryKey: ['docker-image-inspect', selected],
    enabled: !!selected,
    queryFn: async () =>
      parseImage((await window.orkestral['docker:image-inspect']({ id: selected! })).json),
  });

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
              {images.length} imagens · {fmtBytes(totalMb * 1024 * 1024)}
            </div>
            <div className="flex flex-col gap-0.5 p-2">
              {images.map((i) => {
                const label = i.tags[0] ?? shortId(i.id);
                const { Icon, color } = dockerImageIcon(i.tags[0] ?? i.id);
                return (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => setSelected(i.id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left',
                      selected === i.id ? 'bg-surface-elevated' : 'hover:bg-surface-elevated',
                    )}
                  >
                    <Icon className="h-5 w-5 shrink-0" style={{ color }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-text-primary">{label}</span>
                      <span className="block truncate text-[11px] text-text-muted">
                        {fmtBytes(i.sizeMb * 1024 * 1024)}
                        {i.created ? ` · ${fmtDate(i.created)}` : ''}
                      </span>
                    </span>
                  </button>
                );
              })}
              {images.length === 0 && (
                <p className="px-2 py-4 text-[12px] text-text-faint">Nenhuma imagem.</p>
              )}
            </div>
          </div>
        )
      }
      detail={
        !selected ? (
          <EmptyDetail label="Selecione uma imagem" />
        ) : !inspectData ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        ) : (
          <InfoScroll>
            <Card>
              <Row label="ID" value={inspectData.id} mono />
              <Row label="Tags" value={inspectData.tags} mono divider />
              {inspectData.created && (
                <Row label="Created" value={fmtDate(inspectData.created)} divider />
              )}
              <Row label="Size" value={fmtBytes(inspectData.size)} divider />
              <Row label="Platform" value={inspectData.platform} divider />
            </Card>

            {(inspectData.entrypoint || inspectData.cmd || inspectData.workingDir) && (
              <Section title="Config">
                <Card>
                  {inspectData.entrypoint && (
                    <Row label="Entrypoint" value={inspectData.entrypoint} mono />
                  )}
                  {inspectData.cmd && (
                    <Row
                      label="Cmd"
                      value={inspectData.cmd}
                      mono
                      divider={!!inspectData.entrypoint}
                    />
                  )}
                  {inspectData.workingDir && (
                    <Row
                      label="Working Directory"
                      value={inspectData.workingDir}
                      mono
                      divider={!!(inspectData.entrypoint || inspectData.cmd)}
                    />
                  )}
                </Card>
              </Section>
            )}

            {inspectData.env.length > 0 && (
              <Section title="Environment">
                <KVTable rows={inspectData.env} />
              </Section>
            )}

            {inspectData.ports.length > 0 && (
              <Section title="Exposed Ports">
                <Card>
                  {inspectData.ports.map((p, i) => (
                    <Row key={p} label="Port" value={p} mono divider={i > 0} />
                  ))}
                </Card>
              </Section>
            )}

            {inspectData.labels.length > 0 && (
              <Section title="Labels">
                <KVTable rows={inspectData.labels} />
              </Section>
            )}
          </InfoScroll>
        )
      }
    />
  );
}
