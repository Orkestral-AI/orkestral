import { motion } from 'framer-motion';
import { cn } from '@renderer/lib/utils';

// Partículas dos braços espirais — geradas UMA vez no load (fora do render).
const GALAXY = (() => {
  const arms = 3;
  const perArm = 48;
  const turns = 1.15;
  const maxR = 132;
  const pts: Array<{
    x: number;
    y: number;
    size: number;
    delay: number;
    dur: number;
    color: string;
  }> = [];
  for (let a = 0; a < arms; a++) {
    const off = (a / arms) * Math.PI * 2;
    for (let i = 0; i < perArm; i++) {
      const t = i / perArm;
      const ang = off + t * turns * Math.PI * 2;
      const r = Math.pow(t, 0.82) * maxR;
      const spread = 6 + t * 14;
      const x = Math.cos(ang) * r + (Math.random() - 0.5) * spread;
      const y = Math.sin(ang) * r + (Math.random() - 0.5) * spread;
      const color =
        t < 0.22
          ? 'rgba(255,255,255,0.95)'
          : t < 0.55
            ? 'var(--color-accent-purple)'
            : 'var(--color-accent-blue)';
      pts.push({
        x,
        y,
        size: 2.4 - t * 1.3 + Math.random() * 0.6,
        delay: t * 2.2 + Math.random() * 0.7,
        dur: 2.4 + Math.random() * 1.8,
        color,
      });
    }
  }
  return pts;
})();

// Estrelas de fundo fixas.
const BG_STARS = Array.from({ length: 40 }, () => ({
  x: Math.random() * 100,
  y: Math.random() * 100,
  size: Math.random() * 1.3 + 0.5,
  dur: Math.random() * 3 + 2.5,
  delay: Math.random() * 4,
}));

const ACCENT = 'var(--color-accent-purple)';

/**
 * Empty-state "em breve" reaproveitável — galáxia espiral se formando: 3 braços de
 * partículas (branco no centro → roxo → azul) que acendem do núcleo pra fora em loop,
 * a galáxia inteira girando devagar, núcleo brilhante pulsando. Tudo transform/opacity.
 */
export function ComingSoon({
  title,
  subtitle,
  className,
}: {
  title: string;
  subtitle?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'relative flex h-full w-full items-center justify-center overflow-hidden',
        className,
      )}
    >
      {/* Nebulosa de fundo */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute h-[560px] w-[560px] rounded-full blur-3xl"
        style={{
          background: `radial-gradient(circle, color-mix(in srgb, ${ACCENT} 24%, transparent), transparent 66%)`,
        }}
        animate={{ scale: [1, 1.12, 1], opacity: [0.4, 0.65, 0.4] }}
        transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Estrelas de fundo */}
      {BG_STARS.map((st, i) => (
        <motion.span
          key={`bg${i}`}
          aria-hidden
          className="absolute rounded-full bg-white"
          style={{ left: `${st.x}%`, top: `${st.y}%`, width: st.size, height: st.size }}
          animate={{ opacity: [0, 0.9, 0] }}
          transition={{ duration: st.dur, repeat: Infinity, delay: st.delay, ease: 'easeInOut' }}
        />
      ))}

      {/* Galáxia: braços girando + núcleo */}
      <div className="relative grid h-72 w-72 place-items-center">
        <motion.div
          aria-hidden
          className="absolute inset-0"
          animate={{ rotate: 360 }}
          transition={{ duration: 52, repeat: Infinity, ease: 'linear' }}
        >
          {GALAXY.map((p, i) => (
            <motion.span
              key={i}
              className="absolute left-1/2 top-1/2 rounded-full"
              style={{
                width: p.size,
                height: p.size,
                background: p.color,
                transform: `translate(${p.x}px, ${p.y}px)`,
                boxShadow: `0 0 6px 0 ${p.color}`,
              }}
              animate={{ opacity: [0, 1, 0.55, 1, 0] }}
              transition={{
                duration: p.dur + 2,
                repeat: Infinity,
                delay: p.delay,
                ease: 'easeInOut',
              }}
            />
          ))}
        </motion.div>

        {/* Halo do núcleo */}
        <motion.div
          aria-hidden
          className="absolute h-28 w-28 rounded-full blur-2xl"
          style={{
            background: `radial-gradient(circle, color-mix(in srgb, ${ACCENT} 65%, white), transparent 70%)`,
          }}
          animate={{ scale: [1, 1.18, 1], opacity: [0.5, 0.85, 0.5] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
        />

        {/* Núcleo brilhante */}
        <motion.div
          className="relative h-9 w-9 rounded-full"
          style={{
            background:
              'radial-gradient(circle at 50% 45%, #fff, color-mix(in srgb, var(--color-accent-purple) 85%, white) 45%, color-mix(in srgb, var(--color-accent-blue) 80%, black))',
          }}
          animate={{
            scale: [1, 1.12, 1],
            boxShadow: [
              `0 0 28px 6px color-mix(in srgb, ${ACCENT} 55%, transparent)`,
              `0 0 56px 16px color-mix(in srgb, ${ACCENT} 75%, transparent)`,
              `0 0 28px 6px color-mix(in srgb, ${ACCENT} 55%, transparent)`,
            ],
          }}
          transition={{ duration: 3.6, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>

      {/* Texto */}
      <div className="absolute bottom-10 flex flex-col items-center gap-1.5 text-center">
        <motion.h3
          className="text-[15px] font-semibold text-text-primary"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          {title}
        </motion.h3>
        {subtitle && <p className="ai-shimmer text-[12.5px]">{subtitle}</p>}
      </div>
    </div>
  );
}
