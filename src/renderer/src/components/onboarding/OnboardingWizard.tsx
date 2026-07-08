import { useState, type ReactElement } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, X } from 'lucide-react';
import { useOnboardingStore, TOTAL_STEPS } from '@renderer/stores/onboardingStore';
import { useT } from '@renderer/i18n';
import {
  StepWelcome,
  StepCompany,
  StepAgent,
  StepTasks,
  StepPlan,
  type StepNavProps,
} from './steps';

interface OnboardingWizardProps {
  onComplete: () => Promise<void> | void;
  error?: string | null;
  onDismissError?: () => void;
}

type StepFn = (props: StepNavProps) => ReactElement;

/**
 * Mapa: índice do step → componente.
 *   0  Welcome (StepWelcome — renderizado à parte porque recebe `onStart`)
 *   1  Company (nome do user + company + missão)
 *   2  Agent  (nome + adapter + model + test)
 *   3  Tasks  (objetivos)
 *   4  Plan   (free-local | team-cloud)
 */
const STEP_COMPONENTS: (StepFn | null)[] = [null, StepCompany, StepAgent, StepTasks, StepPlan];

export function OnboardingWizard({ onComplete, error, onDismissError }: OnboardingWizardProps) {
  const { t } = useT();
  const step = useOnboardingStore((s) => s.step);
  const next = useOnboardingStore((s) => s.next);
  const prev = useOnboardingStore((s) => s.prev);
  const user = useOnboardingStore((s) => s.user);
  const company = useOnboardingStore((s) => s.company);
  const [submitting, setSubmitting] = useState(false);

  const isWelcome = step === 0;
  const isLast = step === TOTAL_STEPS - 1;
  const CurrentStep = STEP_COMPONENTS[step];

  // Bloqueio do "Continuar" por step:
  //   1 (Company) — exige nome do user E nome da company
  const blockNext = (() => {
    if (step === 1) {
      return user.name.trim().length < 1 || company.name.trim().length < 1;
    }
    return false;
  })();

  function handleNext() {
    next();
  }
  function handlePrev() {
    prev();
  }

  async function handleFinish() {
    setSubmitting(true);
    try {
      await onComplete();
    } finally {
      setSubmitting(false);
    }
  }

  function renderStep() {
    if (isWelcome) {
      return <StepWelcome onStart={handleNext} />;
    }
    if (!CurrentStep) return null;

    return (
      <CurrentStep
        onContinue={isLast ? handleFinish : handleNext}
        onBack={handlePrev}
        continueLabel={isLast ? t('onboarding.wizard.finishAndOpen') : t('common.continue')}
        continueDisabled={blockNext}
        submitting={submitting}
        showBack
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col overflow-hidden"
      style={{ background: '#0b0a10' }}
    >
      {/* Drag region pros traffic lights — sempre presente atrás de tudo */}
      <div className="window-drag pointer-events-none absolute inset-x-0 top-0 z-30 h-11" />

      {/* Faixa de erro — visível só fora do welcome */}
      {error && !isWelcome && (
        <div className="window-no-drag absolute left-1/2 top-14 z-40 flex w-[min(420px,90vw)] -translate-x-1/2 items-start gap-2.5 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2.5 backdrop-blur-md">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent-red" />
          <div className="flex-1 text-[12px] text-text-primary">
            <div className="font-medium text-accent-red">{t('onboarding.wizard.errorTitle')}</div>
            <div className="mt-0.5 text-text-secondary">{error}</div>
          </div>
          {onDismissError && (
            <button
              type="button"
              onClick={onDismissError}
              className="ml-1 grid h-5 w-5 place-items-center rounded text-text-muted hover:bg-surface-active hover:text-text-primary"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* Conteúdo — sem header/progress; cada step controla suas próprias ações */}
      <div className="relative z-10 flex flex-1 flex-col overflow-hidden">
        <div className="relative flex-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35, ease: 'easeInOut' }}
              className="absolute inset-0"
            >
              {renderStep()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
