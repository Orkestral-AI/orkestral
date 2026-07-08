import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useDragControls } from 'framer-motion';
import { Code2, X, GripVertical } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useT } from '@renderer/i18n';
import { useIdeChatStore } from '@renderer/stores/ideChatStore';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import { DSSelect } from '@renderer/components/ui/ds-select';
import { ChatSurface } from '@renderer/components/chat/ChatSurface';

// ─────────────────────────────────────────────────────────────────────────────

export function SelectionChips() {
  const { t } = useT();
  const selections = useIdeChatStore((s) => s.pendingSelections);
  const removeSelection = useIdeChatStore((s) => s.removeSelection);

  if (selections.length === 0) return null;

  return (
    // px-6 alinha o canto esquerdo dos chips com a caixa do input (ChatPrompt usa px-6).
    <div className="flex flex-wrap gap-1 px-6 pb-1.5 pt-1">
      {selections.map((sel) => {
        const label = sel.component ?? sel.tag;
        const suffix = sel.line != null ? `:${sel.line}` : '';
        return (
          <span
            key={sel.id}
            className="inline-flex items-center gap-1 rounded-md border border-hairline bg-surface-1 px-1.5 py-0.5 text-[11px] text-text-secondary"
          >
            <Code2 className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="max-w-[160px] truncate">
              {label}
              {suffix}
            </span>
            <button
              type="button"
              aria-label={t('layout.codeIde.ideChat.removeSelection')}
              onClick={() => removeSelection(sel.id)}
              className="ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-text-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Só prepend de refs de seleção (curtas) no conteúdo enviado. O dump do terminal
 * NÃO entra mais na mensagem — virava ruído visível no chat. "Contexto de terminal
 * oculto pro agente" exige campo separado persistido no backend (o agente lê a msg
 * persistida de forma assíncrona); fica pra um PR de backend dedicado.
 */
export function buildTransformContent() {
  return (content: string): string => {
    const sels = useIdeChatStore.getState().pendingSelections;
    if (sels.length === 0) return content;
    const refs = sels
      .map((s) =>
        s.file
          ? `@${s.file}${s.line != null ? `:${s.line}` : ''} (${s.component ?? s.tag})`
          : `[${s.tag}${s.text ? ` "${s.text}"` : ''}]`,
      )
      .join('\n');
    return `${refs}\n\n${content}`;
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export function IdeChatDrawer() {
  const { t } = useT();
  const open = useIdeChatStore((s) => s.open);
  const activeSessionId = useIdeChatStore((s) => s.activeSessionId);
  const closeDrawer = useIdeChatStore((s) => s.closeDrawer);
  const setSession = useIdeChatStore((s) => s.setSession);
  const workspaceId = useWorkspaceStore((s) => s.active?.id);
  const dragControls = useDragControls();
  // Constraints = viewport inteiro (portal no body) → card arrasta pelo app todo e
  // bate nas bordas sem passar.
  const constraintsRef = useRef<HTMLDivElement>(null);

  // Histórico: lista as sessões do workspace (chatStore.list não hidrata na IDE).
  const sessionsQuery = useQuery({
    queryKey: ['sessions', workspaceId],
    enabled: !!workspaceId && open,
    queryFn: () => window.orkestral['session:list']({ workspaceId: workspaceId! }),
  });
  const sessions = sessionsQuery.data ?? [];

  // Build at call time so it reads store state fresh on every send.
  // Stable identity isn't required — ChatSurface calls it only on submit.
  const transformContent = buildTransformContent();

  const sessionOptions = [
    { value: 'new' as const, label: t('layout.codeIde.ideChat.newChat') },
    ...sessions.map((sess) => ({ value: sess.id, label: sess.title })),
  ];

  return createPortal(
    <AnimatePresence>
      {open && (
        // Container = a ÁREA DE CÓDIGO (ancestral relative em SourceDetailPage), ACIMA do
        // terminal — `absolute inset-0` (não `fixed`) pro chat nunca invadir o terminal.
        // pointer-events-none deixa o editor clicável; só o card intercepta. É o ref de drag.
        <div ref={constraintsRef} className="pointer-events-none absolute inset-0 z-[60]">
          <motion.aside
            key="ide-chat-drawer"
            drag
            dragConstraints={constraintsRef}
            dragControls={dragControls}
            dragListener={false}
            dragMomentum={false}
            dragElastic={0}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 340, damping: 30 }}
            // window-no-drag: sem isso o `-webkit-app-region: drag` do app intercepta
            // o pointerdown no nível da janela (arrasta a JANELA, não o card).
            // Ancorado ACIMA do FAB (que fica em bottom-4 h-11) no canto inferior direito —
            // abre como popover que cresce a partir do botão (origin-bottom-right).
            className="window-no-drag pointer-events-auto absolute bottom-24 right-4 flex h-[74%] max-h-[660px] w-[400px] max-w-[calc(100vw-2rem)] origin-bottom-right flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl shadow-black/50"
          >
            {/* Header enxuto — arrasta pelo espaço vazio; select de sessão ghost (truncado). */}
            <div
              onPointerDown={(e) => dragControls.start(e)}
              className="flex h-11 shrink-0 cursor-grab select-none items-center gap-1.5 border-b border-hairline-soft px-2.5 active:cursor-grabbing"
            >
              <GripVertical className="h-3.5 w-3.5 shrink-0 text-text-faint" aria-hidden="true" />
              <div onPointerDown={(e) => e.stopPropagation()} className="min-w-0 flex-1">
                <DSSelect
                  value={activeSessionId}
                  onChange={setSession}
                  options={sessionOptions}
                  className="h-8 w-full min-w-0 border-0 bg-transparent px-1.5 text-[13px] font-medium hover:bg-surface-subtle"
                />
              </div>
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={closeDrawer}
                aria-label={t('layout.codeIde.ideChat.close')}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-subtle hover:text-text-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="min-h-0 flex-1">
              <ChatSurface
                sessionId={activeSessionId}
                onSessionCreated={setSession}
                composerExtras={<SelectionChips />}
                transformContent={transformContent}
                afterSend={() => useIdeChatStore.getState().clearSelections()}
              />
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
