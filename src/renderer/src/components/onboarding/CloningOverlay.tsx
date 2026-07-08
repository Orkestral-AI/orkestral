import { motion } from 'framer-motion';
import { Github, Loader2 } from 'lucide-react';
import { useT } from '@renderer/i18n';

/**
 * Overlay full-screen exibido enquanto o onboarding clona o repo GitHub
 * escolhido. Não tem barra de progresso real (git clone --depth 1 não
 * reporta porcentagem confiável), só feedback visual + repo sendo clonado.
 */
export function CloningOverlay({ repoFullName }: { repoFullName: string }) {
  const { t } = useT();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[#0E0F10]/85 backdrop-blur-md"
    >
      <div className="flex flex-col items-center gap-5 px-8">
        <div className="relative">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-1 ring-1 ring-hairline-strong">
            <Github className="h-7 w-7 text-text-primary" />
          </div>
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
            className="absolute inset-[-6px] rounded-full border border-transparent border-t-hairline-ultra"
          />
        </div>
        <div className="flex flex-col items-center gap-1.5 text-center">
          <div className="text-[15px] font-medium text-text-primary">
            {t('onboarding.cloning.title')}
          </div>
          <div className="font-mono text-[12.5px] text-text-secondary">{repoFullName}</div>
          <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('onboarding.cloning.hint')}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
