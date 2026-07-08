// @refresh reset
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { GalaxyBackground } from './GalaxyBackground';
import { useT } from '@renderer/i18n';
import logoPng from '@renderer/assets/logo_icon.png';

/**
 * Transição visual entre o último passo do onboarding e o dashboard.
 *
 * Sequência:
 *  1. Overlay full-screen com galáxia + logo no centro
 *  2. Mensagem "Preparando workspace" → "Pronto"
 *  3. Logo cresce e brilha, depois fade-out do overlay revela o dashboard
 *
 * Duração total: ~2.6s. `onDone` dispara quando a animação termina e o
 * componente pode ser desmontado.
 */
export function LaunchTransition({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const [phase, setPhase] = useState<'prep' | 'ready' | 'fade'>('prep');

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('ready'), 1200);
    const t2 = setTimeout(() => setPhase('fade'), 1900);
    const t3 = setTimeout(() => onDone(), 2600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [onDone]);

  return (
    <motion.div
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center overflow-hidden"
      style={{ background: '#040308' }}
      initial={{ opacity: 1 }}
      animate={{ opacity: phase === 'fade' ? 0 : 1 }}
      transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1] }}
    >
      <GalaxyBackground />

      {/* Halo central que cresce na transição */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        animate={{
          background:
            phase === 'fade'
              ? 'radial-gradient(60% 50% at 50% 50%, rgba(255,255,255,0.20) 0%, rgba(0,0,0,0) 70%)'
              : 'radial-gradient(28% 22% at 50% 44%, rgba(255,255,255,0.10) 0%, rgba(0,0,0,0) 70%)',
        }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      />

      {/* Vignette */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(80% 60% at 50% 55%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.6) 100%)',
        }}
      />

      {/* Conteúdo */}
      <motion.div
        className="relative z-10 flex flex-col items-center text-center"
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{
          opacity: 1,
          scale: phase === 'fade' ? 1.25 : 1,
        }}
        transition={{
          opacity: { duration: 0.5, ease: 'easeOut' },
          scale: { duration: 0.7, ease: [0.4, 0, 0.2, 1] },
        }}
      >
        {/* Logo */}
        <motion.div
          style={{
            filter:
              'drop-shadow(0 18px 60px rgba(0,0,0,0.8)) drop-shadow(0 6px 18px rgba(0,0,0,0.55))',
          }}
          animate={{
            scale: phase === 'ready' || phase === 'fade' ? 1.05 : 1,
          }}
          transition={{ duration: 0.6, ease: 'easeInOut' }}
        >
          <img
            src={logoPng}
            alt="Orkestral"
            width={108}
            height={108}
            draggable={false}
            style={{ display: 'block', userSelect: 'none' }}
          />
        </motion.div>

        {/* Mensagem */}
        <motion.div
          key={phase}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="mt-8 text-text-secondary"
          style={{
            fontFamily: '"Fira Sans", -apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: '15px',
            fontWeight: 400,
            letterSpacing: '0.02em',
          }}
        >
          {phase === 'prep' && t('onboarding.launch.preparing')}
          {phase === 'ready' && t('onboarding.launch.ready')}
          {phase === 'fade' && t('onboarding.launch.ready')}
        </motion.div>

        {/* Dots de progresso (só no estado prep) */}
        {phase === 'prep' && (
          <div className="mt-5 flex items-center gap-1.5">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="block h-1 w-1 rounded-full bg-text-secondary"
                animate={{ opacity: [0.25, 1, 0.25] }}
                transition={{
                  duration: 1.2,
                  repeat: Infinity,
                  ease: 'easeInOut',
                  delay: i * 0.2,
                }}
              />
            ))}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
