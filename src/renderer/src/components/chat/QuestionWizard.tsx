import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ClipboardList,
  Loader2,
  Pencil,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';
import { useChatStore } from '@renderer/stores/chatStore';
import {
  PLANNING_DECISIONS_HIDDEN,
  wizardKey,
  readWizardPersisted,
  writeWizardPersisted,
  clearWizardPersisted,
} from './ask-user';
import type { AskUserPayload, AskUserQuestion } from './ask-user';

// Persistência (wizardKey/read/write/clear) vive em ./ask-user pra o banner do
// SessionPage também ler o estado "respondido".

/**
 * Wizard de "perguntas de decisão" (estilo Lovable, visual do card de plano): o CEO
 * emite o bloco `<orkestral:ask-user>` antes de planejar um projeto grande/ambíguo. O
 * usuário responde uma pergunta por vez (opção pronta ou "escreva a sua"), revisa e
 * envia. A mensagem de respostas vai ESCONDIDA pro CEO (roda por trás) e as decisões
 * viram um card aqui mesmo; o estado é persistido (sobrevive reload).
 */
export function QuestionWizard({
  sessionId,
  payload,
  onResolved,
}: {
  sessionId: string;
  payload: AskUserPayload;
  /** Chamado quando o usuário responde ou pula, pra o banner da SessionPage refletir
   *  o estado "respondido" (localStorage não é reativo). */
  onResolved?: () => void;
}) {
  const { t } = useT();
  const key = useMemo(() => wizardKey(sessionId, payload), [sessionId, payload]);
  const persisted = useMemo(() => readWizardPersisted(key), [key]);
  const total = payload.questions.length;

  // Decide enviar agora (sessão ociosa) ou enfileirar (run ativo).
  const streamingRunId = useChatStore((s) => s.sessions[sessionId]?.streamingRunId ?? null);

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [mode, setMode] = useState<'ask' | 'review'>('ask');
  const [answers, setAnswers] = useState<Record<string, string>>(() => persisted?.answers ?? {});
  const [customText, setCustomText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<'sent' | 'skipped' | null>(
    () => persisted?.outcome ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  const goTo = (next: number) => {
    setDirection(next > step ? 1 : -1);
    setStep(Math.max(0, Math.min(total - 1, next)));
  };

  // Selecionar uma opção pronta limpa o campo "escreva a sua" (exclusão mútua);
  // digitar no campo vira a resposta e deseleciona as opções.
  const pickOption = (q: AskUserQuestion, label: string) => {
    setCustomText((s) => ({ ...s, [q.id]: '' }));
    setAnswers((a) => ({ ...a, [q.id]: label }));
  };
  const typeCustom = (q: AskUserQuestion, val: string) => {
    setCustomText((s) => ({ ...s, [q.id]: val }));
    setAnswers((a) => ({ ...a, [q.id]: val }));
  };

  const skipMessage = (): string => t('chat.questionWizard.skipMessage');
  const answersMessage = (): string => {
    const lines = payload.questions
      .map((q) => {
        const a = answers[q.id]?.trim();
        return a ? `- ${q.question}: ${a}` : null;
      })
      .filter((l): l is string => l !== null);
    if (lines.length === 0) return skipMessage();
    return `${t('chat.questionWizard.answersHeader')}\n${lines.join('\n')}\n\n${t('chat.questionWizard.proceed')}`;
  };

  const submit = async (skip: boolean) => {
    if (submitting || submitted) return;
    const outcome: 'sent' | 'skipped' = skip ? 'skipped' : 'sent';
    // A mensagem das respostas é ESCONDIDA do chat (marker + filtro no MessageList):
    // o CEO lê as decisões em texto, mas a bolha crua "Minhas decisões" não aparece.
    // Âncora de idioma (msg oculta): o CEO estava driftando pro inglês na continuação.
    const body = skip ? skipMessage() : answersMessage();
    const content = `${PLANNING_DECISIONS_HIDDEN}\n${body}\n\n${t('chat.questionWizard.respondLanguage')}`;
    // Persiste ANTES do await: sobrevive a remount E reload, e trava o duplo-clique.
    writeWizardPersisted(key, { outcome, answers });
    setSubmitting(true);
    setError(null);
    try {
      // Run ativo (raro, o turno da pergunta já terminou): enfileira com segurança.
      // Senão chat:send dispara o run do CEO na hora, que passa a streamar o plano.
      if (streamingRunId) {
        await window.orkestral['chat:enqueue']({ sessionId, content });
      } else {
        await window.orkestral['chat:send']({ sessionId, content });
      }
      setSubmitted(outcome);
      onResolved?.();
    } catch (err) {
      clearWizardPersisted(key);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Estado ENVIADO: card de decisões (mesma linguagem do card de plano).
  if (submitted) {
    return (
      <div className="rounded-xl border border-hairline-strong bg-surface-elevated p-4">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-text-secondary">
          <CheckCircle2 className="h-4 w-4 text-accent-green" />
          {submitted === 'skipped'
            ? t('chat.questionWizard.skippedBadge')
            : t('chat.questionWizard.submittedBadge')}
        </div>
        {submitted === 'sent' && (
          <div className="mt-3 flex flex-col gap-2">
            {payload.questions.map((q) => {
              const a = answers[q.id]?.trim();
              if (!a) return null;
              return (
                <div key={q.id} className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-text-faint">{q.question}</span>
                  <span className="text-[12.5px] font-medium text-text-primary">{a}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const current = payload.questions[step];
  const isLast = step === total - 1;

  return (
    <div className="rounded-xl border border-hairline-strong bg-surface-elevated p-4">
      {/* Header: ícone clipboard azul + título + contador (igual ao card de plano) */}
      <div className="flex items-start gap-2.5">
        <ClipboardList className="mt-0.5 h-4 w-4 shrink-0 text-accent-blue" />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-text-primary">
            {payload.intro ?? t('chat.questionWizard.title')}
          </div>
          <div className="text-[11.5px] text-text-muted">
            {mode === 'review'
              ? t('chat.questionWizard.reviewSubtitle')
              : t('chat.questionWizard.stepOf', { n: step + 1, total })}
          </div>
        </div>
      </div>

      {/* Progresso fininho (azul, acompanha o accent do card) */}
      <div className="mt-3 flex gap-1">
        {payload.questions.map((q, i) => (
          <div
            key={q.id}
            className={cn('h-0.5 flex-1 rounded-full', {
              'bg-accent-blue': i <= step || mode === 'review',
              'bg-hairline': i > step && mode === 'ask',
            })}
          />
        ))}
      </div>

      {mode === 'ask' ? (
        <div className="mt-3.5">
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={current.id}
              initial={{ opacity: 0, x: direction * 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -16 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="text-[13px] font-medium text-text-primary">{current.question}</div>
              <div className="mt-2.5 flex flex-col gap-1.5">
                {current.options.map((opt) => {
                  const selected = answers[current.id] === opt.label;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => pickOption(current, opt.label)}
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
                        selected
                          ? 'border-accent-blue/40 bg-accent-blue/10'
                          : 'border-hairline bg-surface-faint hover:border-hairline-strong hover:bg-surface-1',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                          selected ? 'border-accent-blue' : 'border-hairline-heavy',
                        )}
                      >
                        {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent-blue" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[12.5px] font-medium text-text-primary">
                          {opt.label}
                        </span>
                        {opt.description && (
                          <span className="mt-0.5 block text-[11.5px] text-text-muted">
                            {opt.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}

                {/* "Escreva a sua": campo inline sempre visível. Digitar vira a
                    resposta e deseleciona as opções (pickOption limpa o campo). */}
                {current.allowOther && (
                  <div className="flex items-center gap-2.5 rounded-lg border border-hairline bg-surface-faint px-3 py-1.5">
                    <Pencil className="h-3.5 w-3.5 shrink-0 text-text-faint" />
                    <input
                      value={customText[current.id] ?? ''}
                      onChange={(e) => typeCustom(current, e.target.value)}
                      placeholder={t('chat.questionWizard.otherPlaceholder')}
                      className="w-full bg-transparent py-1 text-[12.5px] text-text-primary outline-none placeholder:text-text-faint"
                    />
                  </div>
                )}
              </div>
            </motion.div>
          </AnimatePresence>

          {/* Navegação */}
          <div className="mt-3.5 flex items-center justify-between">
            <div>
              {step > 0 && (
                <button
                  type="button"
                  onClick={() => goTo(step - 1)}
                  className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[12px] text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  {t('chat.questionWizard.back')}
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => submit(true)}
                disabled={submitting}
                className="inline-flex h-8 items-center rounded-lg px-2.5 text-[12px] text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary disabled:opacity-50"
              >
                {t('chat.questionWizard.skipAll')}
              </button>
              <button
                type="button"
                onClick={() => (isLast ? setMode('review') : goTo(step + 1))}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent-blue px-3.5 text-[12.5px] font-semibold text-white transition-opacity hover:bg-accent-blue/90"
              >
                {isLast ? t('chat.questionWizard.review') : t('chat.questionWizard.next')}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Revisão */
        <div className="mt-3.5">
          <div className="flex flex-col gap-1.5">
            {payload.questions.map((q, i) => {
              const a = answers[q.id]?.trim();
              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => {
                    setMode('ask');
                    goTo(i);
                  }}
                  className="flex items-start gap-2.5 rounded-lg border border-hairline bg-surface-faint px-3 py-2.5 text-left transition-colors hover:border-hairline-strong hover:bg-surface-1"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11.5px] text-text-muted">{q.question}</span>
                    <span
                      className={cn('mt-0.5 block text-[12.5px] font-medium', {
                        'text-text-primary': !!a,
                        'italic text-text-faint': !a,
                      })}
                    >
                      {a || t('chat.questionWizard.noAnswer')}
                    </span>
                  </span>
                  <Pencil className="mt-0.5 h-3 w-3 shrink-0 text-text-faint" />
                </button>
              );
            })}
          </div>
          {error && (
            <div className="mt-2 rounded-lg border border-accent-red/30 bg-accent-red/10 px-3 py-1.5 text-[12px] text-accent-red">
              {error}
            </div>
          )}
          <div className="mt-3.5 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setMode('ask')}
              className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[12px] text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              {t('chat.questionWizard.back')}
            </button>
            <button
              type="button"
              onClick={() => submit(false)}
              disabled={submitting}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent-green px-3.5 text-[13px] font-semibold text-white transition-opacity hover:bg-accent-green/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              {t('chat.questionWizard.submit')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
