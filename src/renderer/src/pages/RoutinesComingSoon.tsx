import { motion, type Variants } from 'framer-motion';
import { Clock, Sparkles, Activity, Orbit } from 'lucide-react';
import { useT } from '@renderer/i18n';

/**
 * Tela de Rotinas no estado "Em breve" (fora deste MVP). Replica EXATAMENTE o
 * header das outras páginas (GoalsPage/CodeReviews: header grande text-[18px],
 * px-8 py-5, padding externo pl-2 pr-4 pt-4 pb-4) e mostra um empty state
 * animado/explicativo com Framer Motion. A RoutinesPage real segue no repo pra
 * reativar depois — só não é roteada por enquanto.
 */
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

const container: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08, delayChildren: 0.08 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT } },
};

export function RoutinesComingSoon(): React.JSX.Element {
  const { t } = useT();
  const features = [
    { icon: Clock, label: t('layout.route.routinesFeature1') },
    { icon: Sparkles, label: t('layout.route.routinesFeature2') },
    { icon: Activity, label: t('layout.route.routinesFeature3') },
  ];

  return (
    <div className="flex h-full flex-col pb-4 pl-2 pr-4 pt-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        {/* Header — mesmo padrão das demais páginas (text-[18px], px-8 py-5). */}
        <div className="window-drag flex items-start justify-between gap-3 border-b border-hairline-soft px-8 py-5">
          <div>
            <h1 className="text-[18px] font-semibold tracking-tight text-text-primary">
              {t('layout.nav.routines')}
            </h1>
            <p className="mt-0.5 text-[12.5px] text-text-muted">
              {t('layout.route.routinesDescription')}
            </p>
          </div>
        </div>

        {/* Empty state animado e explicativo. */}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-6">
          <motion.div
            variants={container}
            initial="hidden"
            animate="visible"
            className="flex w-full max-w-lg flex-col items-center text-center"
          >
            {/* Hero: ícone orbital animado (sem imagem/caixa) — glow roxo
                respirando atrás, dois anéis decorativos e o ícone Orbit girando
                devagar, evocando algo que roda em ciclo (rotina). */}
            <motion.div variants={item} className="relative mb-6 grid h-28 w-28 place-items-center">
              <motion.div
                className="pointer-events-none absolute inset-0 rounded-full bg-accent-purple/20 blur-2xl"
                animate={{ opacity: [0.3, 0.6, 0.3], scale: [0.85, 1.1, 0.85] }}
                transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
              />
              <div className="absolute inset-2 rounded-full border border-accent-purple/15" />
              <div className="absolute inset-5 rounded-full border border-accent-purple/10" />
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 22, repeat: Infinity, ease: 'linear' }}
              >
                <Orbit className="h-14 w-14 text-accent-purple" strokeWidth={1.5} />
              </motion.div>
            </motion.div>

            <motion.span
              variants={item}
              className="inline-flex items-center rounded-full border border-accent-purple/20 bg-accent-purple/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-accent-purple"
            >
              {t('layout.route.routinesBadge')}
            </motion.span>

            <motion.h2
              variants={item}
              className="mt-3 text-[17px] font-semibold tracking-tight text-text-primary"
            >
              {t('layout.route.routinesComingSoonTitle')}
            </motion.h2>

            <motion.p
              variants={item}
              className="mt-2 text-[12.5px] leading-relaxed text-text-muted"
            >
              {t('layout.route.routinesComingSoonDescription')}
            </motion.p>

            {/* Preview do que vem — explicativo pro usuário final. */}
            <motion.div
              variants={item}
              className="mt-6 flex flex-wrap items-center justify-center gap-2"
            >
              {features.map((f) => (
                <span
                  key={f.label}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface-faint px-2.5 py-1.5 text-[11.5px] text-text-secondary"
                >
                  <f.icon className="h-3.5 w-3.5 text-accent-purple/80" />
                  {f.label}
                </span>
              ))}
            </motion.div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
