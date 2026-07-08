import { useEffect, useState, type ReactNode } from 'react';
import { Brain, ChevronDown, FileText, Loader2, ListTree, BookText } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';

/**
 * Componentes inspirados no AI SDK Elements (elements.ai-sdk.dev), adaptados ao
 * tema do Orkestral: Shimmer, Reasoning, Sources e Task.
 *
 * São colapsáveis baseados em estado local (sem dep nova de Radix Collapsible),
 * mas com o mesmo visual/UX: auto-abre enquanto streama, recolhe ao terminar,
 * mostra duração do raciocínio, lista de fontes e tarefa com itens/arquivos.
 */

/* ------------------------------- Shimmer ------------------------------- */

/** Texto com brilho varrendo — estado "pensando/trabalhando". */
export function Shimmer({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('ai-shimmer', className)}>{children}</span>;
}

/* ------------------------------ Reasoning ------------------------------ */

export function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useT();
  const [startedAt] = useState(() => Date.now());
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);

  useEffect(() => {
    if (streaming || elapsedMs !== null) return;
    const frame = requestAnimationFrame(() => {
      setElapsedMs(Date.now() - startedAt);
    });
    return () => cancelAnimationFrame(frame);
  }, [streaming, elapsedMs, startedAt]);

  const open = manualOpen ?? streaming;
  // Auto-aberto só enquanto streama: mostra um PREVIEW curto (cauda do texto,
  // com fade no topo) em vez do raciocínio inteiro acumulando na tela —
  // clique no header expande o texto completo.
  const previewMode = open && streaming && manualOpen === null;
  const secs = elapsedMs != null ? Math.max(1, Math.round(elapsedMs / 1000)) : null;

  return (
    <div className="rounded-lg border border-purple-400/20 bg-purple-400/[0.04]">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-purple-300/90 transition-colors hover:bg-purple-400/[0.04]"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 font-medium">
          {streaming ? (
            <Shimmer>{t('chat.reasoning.thinking')}</Shimmer>
          ) : secs != null ? (
            t('chat.reasoning.thoughtForSeconds', { n: secs })
          ) : (
            t('chat.reasoning.reasoning')
          )}
        </span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div
          className={cn(
            'border-t border-purple-400/15 px-3 py-2.5 text-[12.5px] leading-relaxed text-text-secondary',
            previewMode &&
              'h-[72px] overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_55%)]',
          )}
        >
          {/* No preview, a cauda fica ancorada no fundo — as linhas mais novas
              sempre visíveis, as antigas somem no fade do topo. */}
          <div className={cn(previewMode && 'flex h-full flex-col justify-end')}>
            <div className="prose-reasoning whitespace-pre-wrap break-words">
              {previewMode ? text.slice(-360) : text}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- Sources ------------------------------- */

export interface SourceItem {
  /** Rótulo da ação (Read, Grep, Glob, List…). */
  label: string;
  /** Caminho/descrição da fonte. */
  detail: string;
}

/** Lista colapsável de fontes consultadas (arquivos lidos/buscados). */
export function Sources({ items, streaming }: { items: SourceItem[]; streaming?: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-hairline bg-surface-faint">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-text-muted transition-colors hover:bg-surface-faint"
      >
        <BookText className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          {streaming ? (
            <Shimmer>{t('chat.sources.consulting')}</Shimmer>
          ) : (
            <>
              {t('chat.sources.used')}{' '}
              <span className="text-text-secondary">
                {items.length > 1
                  ? t('chat.sources.countPlural', { n: items.length })
                  : t('chat.sources.count', { n: items.length })}
              </span>
            </>
          )}
        </span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className="flex flex-col border-t border-hairline px-3 py-2">
          {items.map((s, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5 text-[12px]">
              <FileText className="h-3 w-3 shrink-0 text-text-faint" />
              <span className="w-12 shrink-0 text-text-faint">{s.label}</span>
              <span className="truncate text-text-secondary" title={s.detail}>
                {s.detail}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------- Task -------------------------------- */

export interface TaskItemData {
  label: string;
  detail: string;
  /** Quando o item referencia um arquivo, vira um chip estilo TaskItemFile. */
  file?: string;
}

/** Inline chip de arquivo dentro de um TaskItem (estilo AI SDK TaskItemFile). */
export function TaskItemFile({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-hairline-strong bg-surface-1 px-1 py-px font-mono text-[11px] text-text-secondary">
      <FileText className="h-2.5 w-2.5" />
      {children}
    </span>
  );
}

/** Tarefa colapsável com itens (estilo AI SDK Task). */
export function Task({
  title,
  items,
  streaming,
  defaultOpen = true,
}: {
  title: string;
  items: TaskItemData[];
  streaming?: boolean;
  defaultOpen?: boolean;
}) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? defaultOpen;
  return (
    <div className="rounded-lg border border-hairline bg-surface-faint">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-surface-faint"
      >
        {streaming ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-muted" />
        ) : (
          <ListTree className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        )}
        <span className="flex-1 font-medium text-text-secondary">
          {streaming ? <Shimmer>{title}</Shimmer> : title}
        </span>
        <span className="shrink-0 text-[11px] text-text-faint">{items.length}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 border-t border-hairline px-3 py-2">
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5 text-[12px]">
              <span className="w-20 shrink-0 truncate text-text-faint">{it.label}</span>
              {it.file ? (
                <TaskItemFile>{it.file}</TaskItemFile>
              ) : (
                <span className="min-w-0 flex-1 truncate text-text-secondary" title={it.detail}>
                  {it.detail}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
