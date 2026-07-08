import {
  BookOpen,
  Boxes,
  Brain,
  Bug,
  CirclePlus,
  FlaskConical,
  Gauge,
  GitPullRequest,
  RefreshCw,
  Repeat,
  Rocket,
  ShieldCheck,
  Sparkles,
  Wand2,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';

export interface Suggestion {
  /** Categoria (objective id ou genérico) — define ícone/cor. */
  id: string;
  /** Texto que vira a 1ª mensagem ao clicar. */
  text: string;
}

interface SuggestionCardsProps {
  suggestions: Suggestion[];
  onSelect?: (value: string) => void;
  /** Rótulo sutil da seção (ex.: "Algumas sugestões pra começar"). */
  label?: string;
  /** Ação "Atualizar" — rotaciona/gera mais sugestões. */
  onRefresh?: () => void;
  refreshLabel?: string;
}

/** Ícone por categoria (só a forma muda; a cor é uniforme — roxa). */
const ICONS: Record<string, LucideIcon> = {
  'code-review': GitPullRequest,
  'code-build': Boxes,
  bugfix: Bug,
  architecture: Workflow,
  refactor: Wand2,
  performance: Gauge,
  docs: BookOpen,
  tests: FlaskConical,
  security: ShieldCheck,
  'ci-cd': Rocket,
  memory: Brain,
  routines: Repeat,
  createIssue: CirclePlus,
};
/** Cor única dos ícones: roxinha sutil e consistente em todos os cards. */
const TINT = 'bg-accent-purple/10 text-accent-purple';

/**
 * Cards de sugestão (estilo "recomendações" do Lobe): header sutil com ação de
 * atualizar + grade de cards com ícone colorido e o texto da sugestão. Clicar
 * envia o texto como primeira mensagem.
 */
export function SuggestionCards({
  suggestions,
  onSelect,
  label,
  onRefresh,
  refreshLabel,
}: SuggestionCardsProps) {
  if (suggestions.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5">
      {(label || onRefresh) && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-text-faint">{label}</span>
          {onRefresh && refreshLabel && (
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex items-center gap-1.5 text-[11px] text-text-muted transition-colors hover:text-text-secondary"
            >
              <RefreshCw className="h-3 w-3" />
              {refreshLabel}
            </button>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2.5">
        {suggestions.map((s) => {
          const Icon = ICONS[s.id] ?? Sparkles;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelect?.(s.text)}
              className="group flex min-h-[60px] items-center gap-3 rounded-xl border border-hairline bg-surface-subtle p-3.5 text-left transition-all hover:border-hairline-strong hover:bg-surface-1"
            >
              <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', TINT)}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="line-clamp-2 flex-1 text-[12.5px] leading-snug text-text-secondary group-hover:text-text-primary">
                {s.text}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
