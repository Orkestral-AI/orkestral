import { useEffect, useRef } from 'react';
import { cn } from '@renderer/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { useT } from '@renderer/i18n';

export interface MentionItem {
  id: string;
  label: string;
  /** Prefixo de diretório (apagado) renderizado antes do label — estilo opencode
   *  pra menções de arquivo/pasta: `dir/` em cor faint + nome em destaque. */
  dir?: string;
  description?: string;
  icon?: LucideIcon;
  /** Avatar do agente — tem prioridade sobre `icon` quando presente. */
  avatar?: { seed?: string | null; name?: string | null };
  /** Badge curto à direita (ex: "skill"). */
  badge?: string;
  /** Texto que será inserido no input quando o item é selecionado. */
  insert: string;
}

interface MentionsMenuProps {
  items: MentionItem[];
  highlight: number;
  onSelect: (item: MentionItem) => void;
  onHover: (index: number) => void;
  /** Posiciona o menu acima ou abaixo do âncora. Padrão: above. */
  placement?: 'above' | 'below';
  /** Título do menu (ex: "Comandos", "Agentes"). */
  title: string;
  /** Caption no rodapé do menu. */
  hint?: string;
  emptyLabel?: string;
  /** Altura máxima da lista (px) — cap medido pelo pai pra nunca cortar. */
  listMaxHeight?: number;
}

/**
 * Popover de autocomplete (slash commands / @ mentions). Renderizado em cima
 * do prompt input. Navegação com setas é controlada pelo pai via `highlight`.
 *
 * Visual: cards compactos, paleta neutra (sem roxo).
 */
export function MentionsMenu({
  items,
  highlight,
  onSelect,
  onHover,
  placement = 'above',
  title,
  hint,
  emptyLabel,
  listMaxHeight,
}: MentionsMenuProps) {
  const { t } = useT();
  const resolvedEmptyLabel = emptyLabel ?? t('chat.menu.noResultsDefault');
  const listRef = useRef<HTMLDivElement>(null);
  // Marca quando a última mudança de highlight veio do mouse (hover). Hover
  // NÃO deve auto-scrollar — só a navegação por teclado. Sem isso, passar o
  // mouse num item meio cortado arrastava a lista/tela.
  const fromMouse = useRef(false);

  // Auto-scroll só na navegação por teclado, e via scrollTop manual no próprio
  // container (scrollIntoView arrastava ancestrais, mexendo a tela inteira).
  useEffect(() => {
    if (fromMouse.current) {
      fromMouse.current = false;
      return;
    }
    const container = listRef.current;
    const el = container?.querySelector<HTMLElement>(`[data-mention-idx="${highlight}"]`);
    if (!container || !el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < container.scrollTop) {
      container.scrollTop = top;
    } else if (bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = bottom - container.clientHeight;
    }
  }, [highlight]);

  return (
    <div
      className={cn(
        'absolute left-0 z-50 w-[320px] overflow-hidden rounded-lg border border-hairline-strong bg-dialog shadow-2xl',
        placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-2',
      )}
    >
      {/* Header */}
      <div className="border-b border-hairline-faint px-3 py-2 text-[10.5px] font-medium uppercase tracking-[0.18em] text-text-faint">
        {title}
      </div>

      {/* Itens */}
      <div
        ref={listRef}
        className="no-scrollbar overflow-y-auto py-1"
        style={{ maxHeight: listMaxHeight ?? 260 }}
      >
        {items.length === 0 ? (
          <div className="px-3 py-3 text-[12.5px] text-text-muted">{resolvedEmptyLabel}</div>
        ) : (
          items.map((item, i) => {
            const Icon = item.icon;
            const active = i === highlight;
            return (
              <button
                key={item.id}
                type="button"
                data-mention-idx={i}
                onMouseEnter={() => {
                  fromMouse.current = true;
                  onHover(i);
                }}
                onMouseDown={(e) => {
                  // Evita perder o foco do textarea antes do click resolver
                  e.preventDefault();
                  onSelect(item);
                }}
                className={cn(
                  'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors',
                  active ? 'bg-surface-active' : 'hover:bg-surface-hover',
                )}
              >
                {item.avatar ? (
                  <AgentAvatar
                    seed={item.avatar.seed}
                    name={item.avatar.name}
                    size={18}
                    className="mt-0.5"
                  />
                ) : (
                  Icon && (
                    <Icon
                      className={cn(
                        'mt-0.5 h-3.5 w-3.5 shrink-0',
                        active ? 'text-text-primary' : 'text-text-secondary',
                      )}
                    />
                  )
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px]">
                      {item.dir && <span className="text-text-faint">{item.dir}</span>}
                      <span className="font-medium text-text-primary">{item.label}</span>
                    </span>
                    {item.badge && (
                      <span className="shrink-0 rounded border border-hairline-heavy bg-surface-1 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-text-secondary">
                        {item.badge}
                      </span>
                    )}
                  </div>
                  {item.description && (
                    <div className="text-[11px] leading-snug text-text-muted">
                      {item.description}
                    </div>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Hint footer */}
      {hint && (
        <div className="border-t border-hairline-faint px-3 py-1.5 text-[10.5px] text-text-faint">
          {hint}
        </div>
      )}
    </div>
  );
}
