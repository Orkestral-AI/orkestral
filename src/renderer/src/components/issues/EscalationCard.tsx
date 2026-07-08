import { ArrowRight, ArrowUpRight, Sparkles } from 'lucide-react';
import { useT } from '@renderer/i18n';

/**
 * Parse do corpo do comentário de escalonamento que o backend grava:
 * `↗︎ Orkestral Forge escalou pro modelo premium (adapter): motivo`.
 * Retorna null quando o comentário NÃO é de escalonamento (renderiza normal).
 */
export function parseEscalation(body: string): { adapter: string; reason: string } | null {
  if (!body.trimStart().startsWith('↗')) return null;
  const m = body.match(/\(([^)]+)\):\s*([\s\S]+)$/);
  // Sem o padrão "(adapter): motivo" não é um escalonamento bem-formado → cai no comentário normal.
  if (!m) return null;
  return { adapter: m[1].trim(), reason: m[2].trim() };
}

/**
 * Card de escalonamento: distinto dos comentários comuns (sistema cinza). Mostra que o Forge
 * local passou a bola pro premium, com o de→para dos modelos e o motivo. Cor roxa = premium.
 */
export function EscalationCard({
  adapter,
  reason,
  time,
}: {
  adapter: string;
  reason: string;
  time: string;
}): React.ReactElement {
  const { t } = useT();
  return (
    <div className="overflow-hidden rounded-lg border border-accent-purple/25 bg-accent-purple/[0.06]">
      <div className="flex items-center gap-2 border-b border-accent-purple/15 px-3 py-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-purple/20 text-accent-purple">
          <ArrowUpRight className="h-3 w-3" strokeWidth={2.75} />
        </span>
        <span className="text-[12px] font-medium text-text-primary">
          {t('issues.escalation.title')}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 text-[10.5px] text-text-faint">{time}</span>
      </div>
      <div className="px-3 py-2.5">
        <div className="mb-2 flex items-center gap-1.5 text-[11px]">
          <span className="rounded-md bg-surface px-1.5 py-0.5 text-text-secondary">
            {t('issues.escalation.local')}
          </span>
          <ArrowRight className="h-3 w-3 shrink-0 text-accent-purple" />
          <span className="inline-flex items-center gap-1 rounded-md bg-accent-purple/15 px-1.5 py-0.5 text-accent-purple">
            <Sparkles className="h-2.5 w-2.5" />
            {t('issues.escalation.premium')}
            {adapter ? <span className="text-accent-purple/70">· {adapter}</span> : null}
          </span>
        </div>
        <p className="text-[12px] leading-relaxed text-text-secondary">{reason}</p>
      </div>
    </div>
  );
}
