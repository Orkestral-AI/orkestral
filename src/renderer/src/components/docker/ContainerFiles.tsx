import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Folder, File as FileIcon, Link2, ChevronRight, Loader2, ArrowLeft } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

/**
 * Aba "Files" — navega o filesystem do container (estilo OrbStack). Lista via IPC
 * `docker:list-files` (que roda `ls` lá dentro). Renderizar com `key={id}` no pai
 * pra resetar o path ao trocar de container.
 */
export function ContainerFiles({ id }: { id: string }) {
  const [path, setPath] = useState('/');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['docker-files', id, path],
    queryFn: () => window.orkestral['docker:list-files']({ id, path }),
  });

  const entries = data?.entries ?? [];
  const segments = path.split('/').filter(Boolean);

  function goTo(index: number): void {
    setPath(index < 0 ? '/' : '/' + segments.slice(0, index + 1).join('/'));
  }
  function open(name: string): void {
    setPath(path === '/' ? `/${name}` : `${path}/${name}`);
  }
  function up(): void {
    if (path === '/') return;
    const parts = segments.slice(0, -1);
    setPath(parts.length ? '/' + parts.join('/') : '/');
  }

  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumb */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-hairline-soft px-3 py-2 text-[12px]">
        <button
          type="button"
          onClick={up}
          disabled={path === '/'}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-30"
          title="Voltar"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => goTo(-1)}
          className="shrink-0 rounded px-1.5 py-0.5 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        >
          /
        </button>
        {segments.map((seg, i) => (
          <span key={i} className="flex shrink-0 items-center">
            <ChevronRight className="h-3 w-3 text-text-faint" />
            <button
              type="button"
              onClick={() => goTo(i)}
              className="rounded px-1 py-0.5 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      {/* Header da tabela */}
      <div className="flex shrink-0 items-center gap-3 border-b border-hairline-faint px-3 py-1.5 text-[11px] font-medium text-text-muted">
        <span className="flex-1">Name</span>
        <span className="w-40 shrink-0">Date Modified</span>
        <span className="w-20 shrink-0 text-right">Size</span>
        <span className="w-20 shrink-0">Kind</span>
      </div>

      {/* Lista */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        ) : isError ? (
          <div className="flex h-full items-center justify-center text-[13px] text-text-muted">
            Não foi possível listar os arquivos.
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-text-faint">
            Pasta vazia.
          </div>
        ) : (
          entries.map((e) => {
            const Icon = e.kind === 'Folder' ? Folder : e.kind === 'Symlink' ? Link2 : FileIcon;
            return (
              <div
                key={e.name}
                role={e.isDir ? 'button' : undefined}
                tabIndex={e.isDir ? 0 : undefined}
                onClick={() => e.isDir && open(e.name)}
                onKeyDown={(ev) => {
                  if (e.isDir && (ev.key === 'Enter' || ev.key === ' ')) {
                    ev.preventDefault();
                    open(e.name);
                  }
                }}
                className={cn(
                  'flex items-center gap-3 px-3 py-1.5 text-[12.5px]',
                  e.isDir ? 'cursor-pointer hover:bg-surface-elevated' : 'cursor-default',
                )}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Icon
                    className={cn(
                      'h-4 w-4 shrink-0',
                      e.kind === 'Folder' ? 'text-accent-blue' : 'text-text-muted',
                    )}
                  />
                  <span className="truncate text-text-primary">{e.name}</span>
                </span>
                <span className="w-40 shrink-0 text-[11.5px] text-text-muted">{e.modified}</span>
                <span className="w-20 shrink-0 text-right font-mono text-[11.5px] text-text-muted">
                  {e.isDir ? '—' : fmtSize(e.size)}
                </span>
                <span className="w-20 shrink-0 text-[11.5px] text-text-muted">{e.kind}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function fmtSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / Math.pow(1024, i);
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}
