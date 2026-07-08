import { motion, type Variants } from 'framer-motion';
import { FileCode2, Save, Columns2, Palette } from 'lucide-react';
import { useT } from '@renderer/i18n';
import { getFileIconUrl } from '@renderer/lib/materialIcons';

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

const container: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08, delayChildren: 0.06 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE_OUT } },
};
const pop: Variants = {
  hidden: { opacity: 0, scale: 0.6 },
  visible: { opacity: 1, scale: 1, transition: { duration: 0.5, ease: EASE_OUT } },
};

// Arquivos que orbitam o ícone central (ícones Material reais), distribuídos no círculo.
const ORBIT_FILES = ['index.ts', 'data.json', 'styles.css', 'readme.md'];
const ORBIT_RADIUS = 92; // px
const ORBIT_DURATION = 20; // s por volta

/** Empty state da área de edição (nenhum arquivo aberto). Ícone central flutuando
 *  com glow, anéis de sonar pulsando e ícones de arquivo orbitando ao redor. */
export function EditorEmptyState() {
  const { t } = useT();
  const hints = [
    { icon: Save, label: t('layout.codeIde.hintSave') },
    { icon: Columns2, label: t('layout.codeIde.hintTabs') },
    { icon: Palette, label: t('layout.codeIde.hintSyntax') },
  ];

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="visible"
      className="flex h-full w-full select-none flex-col items-center justify-center px-6 text-center"
    >
      {/* Palco da animação: anéis sonar + órbita + núcleo */}
      <motion.div variants={pop} className="relative mb-8 grid h-56 w-56 place-items-center">
        {/* glow de fundo respirando */}
        <motion.div
          className="pointer-events-none absolute h-32 w-32 rounded-full bg-accent-purple/20 blur-3xl"
          animate={{ opacity: [0.25, 0.55, 0.25], scale: [0.9, 1.15, 0.9] }}
          transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
        />

        {/* anéis de sonar — escalam pra fora e somem em loop escalonado */}
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="pointer-events-none absolute h-24 w-24 rounded-full border border-accent-purple/30"
            animate={{ scale: [0.7, 1.9], opacity: [0.5, 0] }}
            transition={{ duration: 3.6, repeat: Infinity, ease: 'easeOut', delay: i * 1.2 }}
          />
        ))}

        {/* anel da órbita (linha sutil) */}
        <div
          className="pointer-events-none absolute rounded-full border border-dashed border-hairline"
          style={{ height: ORBIT_RADIUS * 2, width: ORBIT_RADIUS * 2 }}
        />

        {/* ícones orbitando — o anel gira; cada ícone contra-gira pra ficar de pé */}
        <motion.div
          className="absolute inset-0"
          animate={{ rotate: 360 }}
          transition={{ duration: ORBIT_DURATION, repeat: Infinity, ease: 'linear' }}
        >
          {ORBIT_FILES.map((name, i) => {
            const angle = (360 / ORBIT_FILES.length) * i;
            const url = getFileIconUrl(name);
            return (
              <div
                key={name}
                className="absolute left-1/2 top-1/2"
                style={{
                  transform: `rotate(${angle}deg) translateY(-${ORBIT_RADIUS}px) rotate(-${angle}deg)`,
                }}
              >
                <motion.div
                  className="grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl border border-hairline bg-surface-elevated shadow-lg"
                  animate={{ rotate: -360 }}
                  transition={{ duration: ORBIT_DURATION, repeat: Infinity, ease: 'linear' }}
                >
                  {url ? (
                    <img src={url} className="h-5 w-5" alt="" />
                  ) : (
                    <FileCode2 className="h-5 w-5 text-accent-purple" />
                  )}
                </motion.div>
              </div>
            );
          })}
        </motion.div>

        {/* núcleo: glyph de código flutuando dentro de um card com borda roxa */}
        <motion.div
          animate={{ y: [-4, 4, -4] }}
          transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
          className="relative grid h-20 w-20 place-items-center rounded-2xl border border-accent-purple/30 bg-gradient-to-b from-accent-purple/15 to-transparent backdrop-blur-sm"
        >
          <FileCode2 className="h-9 w-9 text-accent-purple" strokeWidth={1.5} />
        </motion.div>
      </motion.div>

      <motion.h2
        variants={item}
        className="text-[18px] font-semibold tracking-tight text-text-primary"
      >
        {t('layout.codeIde.emptyTitle')}
      </motion.h2>
      <motion.p
        variants={item}
        className="mt-2 max-w-xs text-[12.5px] leading-relaxed text-text-muted"
      >
        {t('layout.codeIde.emptyDescription')}
      </motion.p>

      <motion.div variants={item} className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {hints.map((h) => (
          <span
            key={h.label}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface-faint px-2.5 py-1.5 text-[11.5px] text-text-secondary"
          >
            <h.icon className="h-3.5 w-3.5 text-accent-purple/80" />
            {h.label}
          </span>
        ))}
      </motion.div>
    </motion.div>
  );
}
