import { AnimatePresence, motion } from 'framer-motion';
import { SlidersHorizontal } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';

export type AutonomyLevel = 'low' | 'medium' | 'high';

const LEVELS: AutonomyLevel[] = ['low', 'medium', 'high'];

/**
 * Configuração GLOBAL do workspace: o quanto o time de agentes executa sozinho
 * até o fim antes de pedir aprovação. Slider de 3 paradas, neutro (sem accent
 * roxo), fluido (fill + thumb com transição) e com explicação detalhada do
 * nível selecionado. Reutilizado no onboarding e na config do CEO.
 */
export function AutonomySlider({
  value,
  onChange,
}: {
  value: AutonomyLevel;
  onChange: (level: AutonomyLevel) => void;
}): React.JSX.Element {
  const { t } = useT();
  const idx = Math.max(0, LEVELS.indexOf(value));
  const pct = (idx / (LEVELS.length - 1)) * 100;

  return (
    <div className="rounded-xl border border-hairline-strong bg-surface-faint p-4">
      {/* Cabeçalho — deixa claro que é uma config GLOBAL do workspace. */}
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="h-4 w-4 shrink-0 text-text-secondary" />
        <span className="text-[13px] font-semibold text-text-primary">
          {t('agents.autonomy.label')}
        </span>
        <span className="ml-auto rounded-md border border-hairline-strong bg-surface-1 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-text-faint">
          {t('agents.autonomy.globalBadge')}
        </span>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-muted">
        {t('agents.autonomy.description')}
      </p>

      {/* Slider custom: trilho + fill + thumb com transição (fluido), input range
          invisível por cima pra arrastar/teclado/clique (acessível). */}
      <div className="relative mt-5 h-5 cursor-pointer select-none">
        {/* trilho */}
        <div className="pointer-events-none absolute left-2 right-2 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/[0.09]" />
        {/* paradas */}
        {LEVELS.map((l, i) => (
          <div
            key={l}
            className="pointer-events-none absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-white/20"
            style={{
              left: `calc(8px + ${(i / (LEVELS.length - 1)) * 100}% - ${(i / (LEVELS.length - 1)) * 16}px)`,
            }}
          />
        ))}
        {/* fill */}
        <div
          className="pointer-events-none absolute left-2 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/40 transition-[width] duration-300 ease-out"
          style={{ width: `calc((100% - 16px) * ${pct / 100})` }}
        />
        {/* thumb */}
        <div
          className="pointer-events-none absolute top-1/2 grid h-4 w-4 -translate-y-1/2 place-items-center rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.4)] transition-[left] duration-300 ease-out"
          style={{ left: `calc(8px + (100% - 16px) * ${pct / 100} - 8px)` }}
        />
        <input
          type="range"
          min={0}
          max={LEVELS.length - 1}
          step={1}
          value={idx}
          onChange={(e) => onChange(LEVELS[Number(e.target.value)])}
          aria-label={t('agents.autonomy.label')}
          className="absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 [&::-webkit-slider-runnable-track]:cursor-pointer [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none"
        />
      </div>

      {/* Rótulos das paradas (clicáveis, cursor pointer). */}
      <div className="mt-2 flex justify-between">
        {LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => onChange(l)}
            className={cn(
              'cursor-pointer text-[11px] transition-colors',
              value === l
                ? 'font-semibold text-text-primary'
                : 'text-text-faint hover:text-text-secondary',
            )}
          >
            {t(`agents.autonomy.${l}`)}
          </button>
        ))}
      </div>

      {/* Detalhe do nível selecionado — troca com animação (fluido). */}
      <div className="mt-3 rounded-lg border border-hairline bg-surface-faint px-3 py-2.5">
        <AnimatePresence mode="wait">
          <motion.div
            key={value}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <div className="text-[12.5px] font-semibold text-text-primary">
              {t(`agents.autonomy.${value}`)}
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">
              {t(`agents.autonomy.${value}Detail`)}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
