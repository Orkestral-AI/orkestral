import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

/**
 * Aba "Info" — layout organizado do `docker inspect` (estilo OrbStack), no lugar do
 * dump cru de JSON. Mostra Name/ID/Image/Status + Port Forwards / Mounts / Labels.
 */

interface PortForward {
  hostPort: string;
  containerPort: string;
  protocol: string;
}
interface MountRow {
  source: string;
  destination: string;
}
interface ParsedInfo {
  name: string;
  id: string;
  image: string;
  status: string;
  ip: string | null;
  ports: PortForward[];
  mounts: MountRow[];
  labels: [string, string][];
}

// O inspect é um objeto grande/dinâmico do Dockerode — parse defensivo.
/* eslint-disable @typescript-eslint/no-explicit-any */
function parseInspect(raw: string): ParsedInfo | null {
  let d: any;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!d) return null;

  const state = d.State ?? {};
  const health = state.Health?.Status ? ` (${state.Health.Status})` : '';
  const status = state.Status ? `${state.Status}${health}` : '—';

  const net = d.NetworkSettings ?? {};
  let ip: string | null = net.IPAddress || null;
  if (!ip && net.Networks) {
    for (const n of Object.values<any>(net.Networks)) {
      if (n?.IPAddress) {
        ip = n.IPAddress;
        break;
      }
    }
  }

  const ports: PortForward[] = [];
  const portMap = net.Ports ?? {};
  for (const [key, bindings] of Object.entries<any>(portMap)) {
    const [containerPort, protocol] = key.split('/');
    if (Array.isArray(bindings)) {
      for (const b of bindings) {
        ports.push({
          hostPort: b?.HostPort ?? '—',
          containerPort,
          protocol: (protocol ?? 'tcp').toUpperCase(),
        });
      }
    }
  }

  const mounts: MountRow[] = Array.isArray(d.Mounts)
    ? d.Mounts.map((m: any) => ({ source: m?.Source ?? '—', destination: m?.Destination ?? '—' }))
    : [];

  const labels: [string, string][] = Object.entries<string>(d.Config?.Labels ?? {});

  return {
    name: (d.Name ?? '').replace(/^\//, '') || '—',
    id: (d.Id ?? '').slice(0, 12) || '—',
    image: d.Config?.Image ?? '—',
    status,
    ip,
    ports,
    mounts,
    labels,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function ContainerInfo({ id }: { id: string }) {
  const { data: info, isLoading: loading } = useQuery({
    queryKey: ['docker-inspect', id],
    queryFn: async () => parseInspect((await window.orkestral['docker:inspect']({ id })).json),
  });

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
      </div>
    );
  }
  if (!info) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-text-muted">
        Não foi possível ler os detalhes.
      </div>
    );
  }

  return (
    <div className="thin-scrollbar h-full space-y-5 overflow-y-auto p-4 font-sans text-text-secondary">
      {/* Card de identidade */}
      <div className="overflow-hidden rounded-lg border border-hairline-soft bg-surface-faint">
        <Row label="Name" value={info.name} mono />
        <Row label="ID" value={info.id} mono divider />
        <Row label="Image" value={info.image} mono divider />
        <Row label="Status" value={info.status} divider />
        {info.ip && <Row label="IP" value={info.ip} mono divider />}
      </div>

      {info.ports.length > 0 && (
        <Section title="Port Forwards">
          <Table head={['Host Port', 'Container Port', 'Protocol']}>
            {info.ports.map((p, i) => (
              <tr key={i} className="border-t border-hairline-faint">
                <Td>{p.hostPort}</Td>
                <Td>{p.containerPort}</Td>
                <Td>{p.protocol}</Td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      {info.mounts.length > 0 && (
        <Section title="Mounts">
          <Table head={['Source', 'Destination']}>
            {info.mounts.map((m, i) => (
              <tr key={i} className="border-t border-hairline-faint">
                <Td mono title={m.source}>
                  {m.source}
                </Td>
                <Td mono title={m.destination}>
                  {m.destination}
                </Td>
              </tr>
            ))}
          </Table>
        </Section>
      )}

      {info.labels.length > 0 && (
        <Section title="Labels">
          <Table head={['Key', 'Value']}>
            {info.labels.map(([k, v]) => (
              <tr key={k} className="border-t border-hairline-faint">
                <Td mono title={k}>
                  {k}
                </Td>
                <Td mono title={v}>
                  {v}
                </Td>
              </tr>
            ))}
          </Table>
        </Section>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  divider,
}: {
  label: string;
  value: string;
  mono?: boolean;
  divider?: boolean;
}) {
  return (
    <div className={cnRow(divider)}>
      <span className="shrink-0 text-[12.5px] text-text-muted">{label}</span>
      <span
        className={`min-w-0 truncate text-[12.5px] text-text-primary ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
function cnRow(divider?: boolean): string {
  return `flex items-center justify-between gap-4 px-3.5 py-2.5${divider ? ' border-t border-hairline-faint' : ''}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-text-faint">
        {title}
      </h3>
      <div className="overflow-hidden rounded-lg border border-hairline-soft bg-surface-faint">
        {children}
      </div>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="w-full table-fixed">
      <thead>
        <tr className="bg-surface-1">
          {head.map((h) => (
            <th key={h} className="px-3.5 py-2 text-left text-[11px] font-medium text-text-muted">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Td({ children, mono, title }: { children: ReactNode; mono?: boolean; title?: string }) {
  // max-w-0 + truncate no <td> de table-fixed = corta com reticências (não vaza
  // pra coluna vizinha). title mostra o valor inteiro no hover.
  return (
    <td className="max-w-0 px-3.5 py-2 align-top text-[12px] text-text-secondary">
      <span className={`block truncate ${mono ? 'font-mono' : ''}`} title={title}>
        {children}
      </span>
    </td>
  );
}
