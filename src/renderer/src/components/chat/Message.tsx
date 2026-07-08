import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWorkspaceStore } from '@renderer/stores/workspaceStore';
import {
  Check,
  Copy,
  RefreshCw,
  PenLine,
  Loader2,
  ListChecks,
  X,
  ChevronDown,
  ChevronUp,
  Terminal,
  Globe2,
  Search,
  FileText,
  Film,
  ZoomIn,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@renderer/lib/utils';
import type { ChatMessage, MessagePart } from '@shared/types';
import { CodeBlock } from './CodeBlock';
import { Markdown } from '@renderer/components/ui/markdown';
import { Reasoning, Shimmer } from './elements';
import { AgentAvatar } from '@renderer/components/agents/AgentAvatar';
import { interpolateMentions } from './mentions';
import { parseAskUserBlock } from './ask-user';
import { useT, type TFunction } from '@renderer/i18n';
import { useChatStore } from '@renderer/stores/chatStore';

interface MessageProps {
  message: ChatMessage;
  /** Subtítulo opcional pra mostrar abaixo da msg (ex: "Build · GPT-5 · 22:18"). */
  metadata?: string;
  /** Nome do agente da sessão — usado pra mencionar @<nome> em prompts especiais. */
  agentName?: string;
  /** Seed do avatar do agente — renderiza ícone bottts ao lado da mensagem. */
  agentAvatarSeed?: string | null;
  /** Todos os agentes do workspace — usado pra detectar @mentions e virar chips. */
  allAgents?: Array<{ id: string; name: string; avatarSeed?: string | null }>;
  /** Nome do usuário — exibido como autor das mensagens role='user'. */
  userName?: string;
  /** Quando o user quer regenerar a resposta do assistant. */
  onRegenerate?: () => void;
  /** Quando o user quer editar a própria msg. */
  onEdit?: () => void;
  /** Chave i18n de rótulo fixo no indicador "trabalhando" (ex.: contexto de
   *  contratação) — substitui os verbos genéricos enquanto a resposta não chega. */
  typingHint?: string;
  /** Superfície estreita (popover da IDE) → padding/gap horizontais menores. */
  compact?: boolean;
}

/**
 * Renderização de mensagem no estilo opencode:
 *  - user: bolha à direita, fundo discreto
 *  - assistant: texto plano à esquerda, sem caixa, sem avatar
 *  - tool calls: cards colapsíveis
 *  - hover: mostra botões de copy / regenerate / edit
 *  - typing dots quando streaming sem texto
 */
export function Message({
  message,
  metadata,
  agentName,
  agentAvatarSeed,
  allAgents,
  userName,
  onRegenerate,
  onEdit,
  typingHint,
  compact,
}: MessageProps) {
  const { t } = useT();
  const isUser = message.role === 'user';
  const isStreaming = message.status === 'streaming';
  // Fase VIVA do stream (label vindo do main: "Escrevendo especificação no KB (8kb)…").
  // Existia no chatStore mas nunca era renderizada — um planejamento longo ficava
  // minutos só com verbos genéricos ciclando e parecia travado.
  const livePhaseLabel = useChatStore((s) => {
    const phase = s.sessions[message.sessionId]?.streamingPhase;
    return isStreaming && phase?.messageId === message.id ? (phase.label ?? null) : null;
  });
  const firstText = message.parts.find((p) => p.type === 'text');
  const firstTextValue = firstText?.type === 'text' ? firstText.text : '';
  // Em vez de esconder a mensagem inteira, substituímos o conteúdo por uma
  // versão curta e amigável que marca o agente destinatário. O prompt cheio
  // continua no storage — só a bolha visível é simplificada. As flags são
  // derivadas DENTRO do memo (de primitivos) p/ o React Compiler conseguir
  // rastrear as deps — bootstrap = plano de contratação seedado; hiring-blocks
  // = follow-up interno pós-aprovação que pede só a estrutura técnica do time.
  const displayParts: MessagePart[] = useMemo(() => {
    const isBootstrapPrompt =
      isUser &&
      (firstTextValue.includes('[[HIRING_BOOTSTRAP_HIDDEN]]') ||
        firstTextValue.includes('Modo: HIRING PLAN INICIAL') ||
        firstTextValue.includes('Você é o CEO/Orchestrator do workspace'));
    const isHiringBlocksPrompt = isUser && firstTextValue.includes('[[HIRING_BLOCKS_HIDDEN]]');
    if (!isBootstrapPrompt && !isHiringBlocksPrompt) return message.parts;
    const mention = agentName ? `@${agentName} ` : '';
    return [
      {
        type: 'text' as const,
        text: t(
          isHiringBlocksPrompt ? 'chat.message.hiringBlocksPrompt' : 'chat.message.bootstrapPrompt',
          { mention },
        ),
      },
    ];
  }, [isUser, firstTextValue, agentName, message.parts, t]);

  const textForCopy = useMemo(() => {
    return displayParts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n')
      .trim();
  }, [displayParts]);
  const hasCopyableText = textForCopy.length > 0;

  // Anexos vão pra um grid horizontal no TOPO da mensagem (imagens/arquivos lado
  // a lado, estilo AI SDK Elements); o texto fica EMBAIXO. Por isso separamos do
  // resto das parts em vez de renderizar cada anexo inline na ordem original.
  const attachmentParts = displayParts.filter(
    (p): p is Extract<MessagePart, { type: 'attachment' }> => p.type === 'attachment',
  );
  const nonAttachmentParts = displayParts.filter((p) => p.type !== 'attachment');

  const userInitial = (userName ?? t('chat.message.you')).trim().slice(0, 1).toUpperCase();

  // Resposta interna do fluxo de contratação: só blocos <orkestral:create-agent>
  // (sem prosa). Ela é consumida pelo apply-plan via DB — não renderiza nada
  // pro usuário (nem o raciocínio), senão vira XML cru no meio do chat.
  const isHiringBlocksReply =
    !isUser &&
    firstTextValue.includes('<orkestral:create-agent') &&
    firstTextValue
      .replace(/<orkestral:create-agent[^>]*\/?>/gi, '')
      .replace(/<\/orkestral:create-agent>/gi, '')
      .replace(/HIRING_DECISION:\s*(APPROVED|REJECTED)/gi, '')
      .replace(/\[\[HIRING_BLOCKS_HIDDEN\]\]/g, '')
      .trim() === '';
  if (isHiringBlocksReply) return null;

  // Prompts internos de automação (relatório de fechamento; re-pedido de blocos
  // de issue): a UI esconde a bolha do "usuário" — só a resposta do CEO aparece.
  if (
    isUser &&
    (firstTextValue.includes('[[PLAN_REPORT_HIDDEN]]') ||
      firstTextValue.includes('[[ISSUE_BLOCKS_HIDDEN]]'))
  )
    return null;

  return (
    <div
      className={cn(
        'group relative flex py-3',
        // popover estreito: padding/gap horizontais menores pra aproveitar a largura.
        compact ? 'gap-2.5 px-3.5' : 'gap-3 px-6',
        isUser ? 'justify-end' : 'justify-start',
      )}
    >
      {/* Container da mensagem — bubble pra user, flat pra assistant */}
      <div
        className={cn('flex max-w-[760px] flex-col', isUser ? 'items-end' : 'w-full items-start')}
      >
        <div
          className={cn(
            isUser
              ? 'inline-flex rounded-2xl rounded-br-md border border-hairline bg-surface-1 px-4 py-2.5 text-[14px] leading-relaxed text-text-primary'
              : 'w-full text-[14px] leading-relaxed text-text-primary',
          )}
        >
          {displayParts.length === 0 && isStreaming ? (
            <TypingDots hint={typingHint} liveLabel={livePhaseLabel} />
          ) : (
            <div className="flex flex-col gap-2.5">
              {!isUser && isStreaming && <WorkingTimer liveLabel={livePhaseLabel} />}
              {attachmentParts.length > 0 && (
                <AttachmentGrid attachments={attachmentParts.map((p) => p.attachment)} />
              )}
              {groupParts(nonAttachmentParts).map((group, i) =>
                group.kind === 'tool-cluster' ? (
                  <ToolCluster key={i} parts={group.parts} />
                ) : (
                  <PartRenderer
                    key={i}
                    part={group.part}
                    streaming={isStreaming}
                    message={message}
                    allAgents={allAgents}
                  />
                ),
              )}
            </div>
          )}
        </div>

        {/* Metadata + hover actions. Avatar sutil (14px) integrado no rodapé
            indica visualmente quem é o autor — sem header redundante acima. */}
        {(metadata || onRegenerate || onEdit || hasCopyableText) && (
          <div
            className={cn(
              'mt-1.5 flex items-center gap-1.5 text-[10.5px] text-text-muted',
              isUser ? 'flex-row-reverse' : 'flex-row',
            )}
          >
            {isUser ? (
              <span
                className="grid h-[14px] w-[14px] shrink-0 place-items-center rounded-full bg-surface-strong text-[8px] font-semibold text-text-secondary"
                title={userName ?? t('chat.message.you')}
              >
                {userInitial}
              </span>
            ) : (
              <AgentAvatar
                seed={agentAvatarSeed ?? null}
                name={agentName ?? null}
                size={14}
                rounded="full"
                className="ring-0"
              />
            )}
            {metadata && <span className="opacity-80">{metadata}</span>}

            <div
              className={cn(
                'ml-1 flex items-center gap-0.5 transition-opacity',
                isUser ? 'opacity-0 group-hover:opacity-100' : 'opacity-80 hover:opacity-100',
              )}
            >
              {hasCopyableText && <CopyButton text={textForCopy} />}
              {!isUser && onRegenerate && (
                <HoverAction onClick={onRegenerate} title={t('chat.message.regenerate')}>
                  <RefreshCw className="h-3 w-3" />
                </HoverAction>
              )}
              {isUser && onEdit && (
                <HoverAction onClick={onEdit} title={t('chat.message.edit')}>
                  <PenLine className="h-3 w-3" />
                </HoverAction>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Agrupa parts consecutivas de `tool-call` num único bloco horizontal
 * (flex-wrap), pra reduzir a verticalidade quando o agente faz muitas
 * chamadas em sequência. Outras parts (text, thinking, attachment, error)
 * ficam isoladas — cada uma com sua altura própria.
 */
type PartGroup =
  | { kind: 'tool-cluster'; parts: Extract<MessagePart, { type: 'tool-call' }>[] }
  | { kind: 'single'; part: MessagePart };

function groupParts(parts: MessagePart[]): PartGroup[] {
  const groups: PartGroup[] = [];
  let cluster: Extract<MessagePart, { type: 'tool-call' }>[] = [];
  const flush = (): void => {
    if (cluster.length > 0) {
      groups.push({ kind: 'tool-cluster', parts: cluster });
      cluster = [];
    }
  };
  for (const p of parts) {
    if (p.type === 'tool-call') {
      cluster.push(p);
    } else {
      flush();
      groups.push({ kind: 'single', part: p });
    }
  }
  flush();
  return groups;
}

// ============================================================================
// Renderer das parts
// ============================================================================

function PartRenderer({
  part,
  streaming,
  message,
  allAgents,
}: {
  part: MessagePart;
  streaming: boolean;
  message: ChatMessage;
  allAgents?: Array<{ id: string; name: string; avatarSeed?: string | null }>;
}) {
  switch (part.type) {
    case 'text':
      return (
        <TextPart
          text={part.text}
          streaming={streaming}
          sessionId={message.sessionId}
          role={message.role}
          allAgents={allAgents}
        />
      );
    case 'thinking':
      return <Reasoning text={part.text} streaming={streaming} />;
    case 'context-compact':
      return <ContextCompactPart part={part} />;
    case 'attachment':
      // Fallback: normalmente os anexos são agrupados no topo da mensagem
      // (AttachmentGrid). Aqui cobre um attachment que chegue avulso.
      return <AttachmentGrid attachments={[part.attachment]} />;
    case 'tool-call':
      return <ToolCluster parts={[part]} />;
    case 'error':
      return (
        <div className="rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-2 text-[12.5px] text-accent-red">
          {part.message}
        </div>
      );
    default:
      return null;
  }
}

function ContextCompactPart({ part }: { part: Extract<MessagePart, { type: 'context-compact' }> }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const running = part.status === 'running';
  const created = new Date(part.createdAt);
  const createdLabel = Number.isNaN(created.getTime())
    ? ''
    : created.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="w-full overflow-hidden rounded-lg border border-hairline-strong bg-surface-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-surface-3"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ListChecks className="h-4 w-4 shrink-0 text-accent-purple" />
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-text-primary">
              {running ? t('chat.contextCompact.compacting') : t('chat.contextCompact.compacted')}
            </span>
            <span className="block truncate text-[11.5px] text-text-muted">
              {running
                ? t('chat.contextCompact.compactingHint')
                : createdLabel
                  ? t('chat.contextCompact.summaryWithTime', {
                      n: part.messagesCompacted,
                      time: createdLabel,
                    })
                  : t('chat.contextCompact.summary', { n: part.messagesCompacted })}
            </span>
          </span>
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-text-muted" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" />
        )}
      </button>
      {open && !running && (
        <div className="border-t border-hairline px-3 py-2 text-[12px] leading-relaxed text-text-secondary">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.summary}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function WorkingTimer({ liveLabel }: { liveLabel?: string | null }) {
  const { t } = useT();
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsedSec = Math.max(1, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = elapsedSec % 60;
  const label =
    minutes > 0
      ? t('chat.workingTimer.minutes', { m: minutes, s: seconds })
      : t('chat.workingTimer.seconds', { s: seconds });

  return (
    <div className="mb-1 border-b border-hairline-strong pb-2 text-[13px] text-text-muted">
      {label}
      {/* Fase viva do stream — prova de progresso em turnos longos (specs de KB, plano). */}
      {liveLabel && <span className="text-text-faint"> · {liveLabel}…</span>}
    </div>
  );
}

/**
 * Decisões de aprovação JÁ disparadas neste processo, por sessionId. O estado
 * local (`busy`/`result`) do card zera quando a mensagem remonta (stream/broadcast
 * re-renderiza a lista) e o botão reaparecia clicável antes do refetch confirmar —
 * 2-3 submits da mesma aprovação. Estes Sets sobrevivem ao remount e travam o
 * botão na hora. A garantia real é a idempotência no main; isto é o latch da UI.
 */
const approvedHiringSessions = new Set<string>();

/**
 * Texto da mensagem renderizado como markdown completo (GFM).
 * Fenced code blocks delegam pro CodeBlock existente (mantém o syntax
 * highlighting + botão de copiar). Headers, listas, tabelas, links etc.
 * ganham estilo inline com o resto do app.
 */
function TextPart({
  text,
  streaming,
  sessionId,
  role,
  allAgents,
}: {
  text: string;
  streaming: boolean;
  sessionId: string;
  role: ChatMessage['role'];
  allAgents?: Array<{ id: string; name: string; avatarSeed?: string | null }>;
}) {
  const { t } = useT();
  const plan = parseHiringPlanResponse(text, sessionId, role, t);
  const queryClient = useQueryClient();
  const workspace = useWorkspaceStore((s) => s.active);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    kind: 'success' | 'skipped' | 'error';
    text: string;
  } | null>(null);

  // Verifica se o plano já foi aplicado: se existe qualquer agente não-CEO
  // no workspace, o time já foi montado. State local some em remount;
  // essa query persiste e mantém o botão disabled mesmo após reload.
  const agentsQuery = useQuery({
    queryKey: ['agents', workspace?.id],
    enabled: !!workspace && !!plan,
    queryFn: () => window.orkestral['agent:list']({ workspaceId: workspace!.id }),
  });
  const existingAgents = agentsQuery.data ?? [];
  const normLower = (s: string): string => s.trim().toLowerCase();
  // Um proposto "já existe" se bate por nome OU role (mesma regra do
  // materializeApprovedHiringPlan no main).
  const proposedExists = (p: { name: string; role: string }): boolean =>
    existingAgents.some(
      (a) =>
        normLower(a.name) === normLower(p.name) ||
        (!!p.role && normLower(a.role) === normLower(p.role)),
    );
  const proposed = plan?.proposedAgents ?? [];
  const hasNewToCreate = proposed.some((p) => !proposedExists(p));
  // Plano com agentes propostos: "já aplicado" só se TODOS já existem (assim um
  // plano que adiciona só o Frontend não fica travado como "já contratado").
  // Sem blocos propostos (proposta em prosa): cai no comportamento antigo.
  const alreadyApplied =
    proposed.length > 0 ? !hasNewToCreate : existingAgents.some((a) => !a.isOrchestrator);

  if (plan) {
    // `latched`: aprovação já disparada neste processo (sobrevive a remount). Trava
    // o botão na hora — a confirmação real (alreadyApplied/result) chega depois.
    const latched = approvedHiringSessions.has(plan.sessionId);
    const done =
      alreadyApplied || latched || result?.kind === 'success' || result?.kind === 'skipped';
    const persistedBadge =
      alreadyApplied && !result
        ? {
            kind: 'success' as const,
            text: t('chat.hiring.alreadyHired', {
              n: (agentsQuery.data ?? []).filter((a) => !a.isOrchestrator).length,
            }),
          }
        : result;
    return (
      <div className="rounded-lg border border-hairline-strong bg-surface-faint p-3.5">
        <div className="text-[14px] font-medium text-text-primary">{t('chat.hiring.title')}</div>
        <Markdown className="mt-1 text-[12.5px]">{plan.summary}</Markdown>
        <div className="mt-2 text-[12px] text-text-muted">
          {t('chat.hiring.suggestedDecision', { decision: plan.decisionLabel })}
        </div>

        {/* Time proposto: cada agente com o modelo que o CEO escolheu (Forge
            local vs premium/Claude) — deixa claro o que roda local antes de aprovar. */}
        {plan.proposedAgents.length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            {plan.proposedAgents.map((a) => (
              <div
                key={a.name}
                className="flex items-center gap-2 rounded-md border border-hairline bg-surface-faint px-2.5 py-1.5"
              >
                <span className="text-[12.5px] font-medium text-text-primary">{a.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-text-faint">
                  {a.title}
                </span>
                {a.model === 'premium' ? (
                  <span className="shrink-0 rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                    {t('chat.hiring.modelPremium')}
                  </span>
                ) : (
                  <span className="shrink-0 rounded border border-accent-green/30 bg-accent-green/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-green">
                    {t('chat.hiring.modelForge')}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Estado pós-decisão: badge bonita em vez de botões. `persistedBadge`
            usa o resultado local OU detecta "já contratado" via agents query
            (sobrevive a remount/reload). */}
        {persistedBadge?.kind === 'success' && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-accent-green/30 bg-accent-green/10 px-3 py-1.5 text-[12px] font-medium text-accent-green">
            <Check className="h-3.5 w-3.5" />
            {persistedBadge.text}
          </div>
        )}
        {persistedBadge?.kind === 'skipped' && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-hairline-strong bg-surface-hover px-3 py-1.5 text-[12px] text-text-muted">
            <X className="h-3.5 w-3.5" />
            {persistedBadge.text}
          </div>
        )}
        {persistedBadge?.kind === 'error' && (
          <div className="mt-3 rounded-md border border-accent-red/30 bg-accent-red/10 px-3 py-1.5 text-[12px] text-accent-red">
            {persistedBadge.text}
          </div>
        )}

        {/* Aprovado mas ainda sem badge terminal (criação em voo, ou remontou no
            meio): mostra "criando" no lugar do botão pra não reabrir o clique. */}
        {latched && !persistedBadge && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-hairline-strong bg-surface-hover px-3 py-1.5 text-[12px] text-text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('chat.hiring.creating')}
          </div>
        )}

        {/* Botões só visíveis enquanto a decisão não foi tomada. */}
        {!done && (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                // Trava a decisão ANTES do await: sobrevive a remount e impede o
                // 2º/3º clique enquanto o apply (que pode re-pedir blocos ao CEO)
                // está em voo.
                approvedHiringSessions.add(plan.sessionId);
                setBusy(true);
                setResult(null);
                try {
                  const resp = await window.orkestral['hiring:apply-plan']({
                    sessionId: plan.sessionId,
                    responseText: text,
                    approved: true,
                  });
                  if (resp.created > 0) {
                    setResult({
                      kind: 'success',
                      text:
                        resp.created > 1
                          ? t('chat.hiring.agentsCreatedPlural', { n: resp.created })
                          : t('chat.hiring.agentsCreated', { n: resp.created }),
                    });
                  } else {
                    setResult({
                      kind: 'skipped',
                      text: t('chat.hiring.noNewAgents'),
                    });
                  }
                  queryClient.invalidateQueries({ queryKey: ['agents'] });
                } catch (err) {
                  // Falhou: destrava pra o usuário poder tentar de novo.
                  approvedHiringSessions.delete(plan.sessionId);
                  setResult({
                    kind: 'error',
                    text: err instanceof Error ? err.message : String(err),
                  });
                } finally {
                  setBusy(false);
                }
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-white transition-opacity hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('chat.hiring.creating')}
                </>
              ) : (
                t('chat.hiring.approveAndCreate')
              )}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setResult({ kind: 'skipped', text: t('chat.hiring.skipped') })}
              className="inline-flex h-8 items-center rounded-md border border-hairline-heavy px-3 text-[12px] text-text-secondary hover:bg-surface-1 disabled:opacity-50"
            >
              {t('chat.hiring.skipForNow')}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Bloco de perguntas de decisão (estilo Lovable): o CEO pergunta antes de
  // planejar um projeto grande/ambíguo. Parseia ANTES dos blocos de issue pra o
  // wizard renderizar junto do texto limpo (sem o JSON cru).
  const askUser = parseAskUserBlock(text, role);
  const issuePlan = parseIssuePlanBlocks(askUser.cleanedText);
  const cleanedText = stripCodeChangeBlocks(issuePlan.cleanedText);

  return (
    <div className="markdown-body flex flex-col gap-3 leading-relaxed">
      {cleanedText.trim().length > 0 && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // Code blocks fenced vs inline code. react-markdown chama `code` em ambos
            // — `inline` está deprecated, então detectamos pela presença de \n no
            // children + match em className (`language-xxx`).
            code({ className, children, ...props }) {
              const raw = String(children ?? '').replace(/\n$/, '');
              const langMatch = /language-(\w+)/.exec(className ?? '');
              const isBlock = (langMatch || raw.includes('\n')) && !('inline' in props);
              if (isBlock) {
                return <CodeBlock code={raw} lang={langMatch?.[1]} />;
              }
              return (
                <code className="rounded bg-surface-active px-1 py-0.5 font-mono text-[12px] text-text-primary">
                  {children}
                </code>
              );
            },
            // react-markdown envolve fenced code num <pre>; deixamos passar limpo
            // porque o CodeBlock já tem seu próprio wrapper.
            pre({ children }) {
              return <>{children}</>;
            },
            p({ children }) {
              return (
                <p className="break-words leading-relaxed">
                  {interpolateMentions(children, allAgents)}
                </p>
              );
            },
            li({ children }) {
              return (
                <li className="leading-relaxed [&>p]:m-0">
                  {interpolateMentions(children, allAgents)}
                </li>
              );
            },
            h1({ children }) {
              return <h1 className="mt-2 text-[18px] font-semibold tracking-tight">{children}</h1>;
            },
            h2({ children }) {
              return <h2 className="mt-2 text-[16px] font-semibold tracking-tight">{children}</h2>;
            },
            h3({ children }) {
              return (
                <h3 className="mt-1.5 text-[14.5px] font-semibold tracking-tight">{children}</h3>
              );
            },
            h4({ children }) {
              return <h4 className="mt-1.5 text-[13.5px] font-semibold">{children}</h4>;
            },
            ul({ children }) {
              return <ul className="ml-5 list-disc space-y-1">{children}</ul>;
            },
            ol({ children }) {
              return <ol className="ml-5 list-decimal space-y-1">{children}</ol>;
            },
            a({ href, children }) {
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-blue underline underline-offset-2 hover:text-accent-blue/80"
                >
                  {children}
                </a>
              );
            },
            blockquote({ children }) {
              return (
                <blockquote className="border-l-2 border-hairline-vivid pl-3 text-text-secondary">
                  {children}
                </blockquote>
              );
            },
            table({ children }) {
              return (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[12.5px]">{children}</table>
                </div>
              );
            },
            thead({ children }) {
              return <thead className="border-b border-hairline-strong">{children}</thead>;
            },
            th({ children }) {
              return (
                <th className="px-2.5 py-1.5 text-left font-medium text-text-secondary">
                  {children}
                </th>
              );
            },
            td({ children }) {
              return <td className="border-t border-hairline-soft px-2.5 py-1.5">{children}</td>;
            },
            hr() {
              return <hr className="border-hairline" />;
            },
            strong({ children }) {
              return <strong className="font-semibold">{children}</strong>;
            },
            em({ children }) {
              return <em>{children}</em>;
            },
          }}
        >
          {cleanedText}
        </ReactMarkdown>
      )}
      {/* O wizard de perguntas (<orkestral:ask-user>) vive no banner/drawer da SessionPage,
          ACIMA do chat (igual a aprovação de plano). Aqui só limpamos o bloco do texto. */}
      {/* A aprovação do plano vive no banner/drawer da SessionPage ("Aprovar todos"), que
          consolida TODOS os épicos num lugar e mostra o estado correto. O card inline antigo
          (IssuePlanCard) duplicava isso e às vezes mostrava "em execução" errado — removido. */}
      {streaming && <StreamingCursor inline />}
    </div>
  );
}

interface PlanIssue {
  title: string;
  assignee?: string;
  priority?: string;
  labels: string[];
  isEpic: boolean;
}

/**
 * Extrai os blocos `<orkestral:create-issue>` do texto e devolve um resumo
 * enxuto (só o que importa pro usuário aprovar) + o texto SEM os blocos nem o
 * corpo verboso. Resolve o "fica com <orkestral:create...> e um tanto de coisa".
 */
function parseIssuePlanBlocks(text: string): { issues: PlanIssue[]; cleanedText: string } {
  const blockRe = /<orkestral:create-issue([^>]*)>([\s\S]*?)<\/orkestral:create-issue>/gi;
  const selfCloseRe = /<orkestral:create-issue([^>]*)\/>/gi;
  const attrRe = /(\w+)\s*=\s*"([^"]*)"/g;
  const issues: PlanIssue[] = [];

  const parseAttrs = (raw: string): PlanIssue | null => {
    const attrs: Record<string, string> = {};
    for (const m of raw.matchAll(attrRe)) attrs[m[1].toLowerCase()] = m[2];
    if (!attrs.title) return null;
    const labels = (attrs.labels ?? '')
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      title: attrs.title.replace(/^\[[ÉE]PICA\]\s*/i, '').trim(),
      assignee: attrs.assignee?.trim() || undefined,
      priority: attrs.priority?.trim() || undefined,
      labels,
      isEpic: /^\[[ÉE]PICA\]/i.test(attrs.title) || labels.includes('epic'),
    };
  };

  let cleaned = text.replace(blockRe, (_full, attrs: string) => {
    const issue = parseAttrs(attrs);
    if (issue) issues.push(issue);
    return '';
  });
  cleaned = cleaned.replace(selfCloseRe, (_full, attrs: string) => {
    const issue = parseAttrs(attrs);
    if (issue) issues.push(issue);
    return '';
  });
  // Remove linhas órfãs que sobraram (atributos soltos pós-stream parcial).
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { issues, cleanedText: cleaned };
}

function stripCodeChangeBlocks(text: string): string {
  const blockRe = /<orkestral:code-changes([^>]*)>([\s\S]*?)<\/orkestral:code-changes>/gi;
  return text
    .replace(blockRe, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseHiringPlanResponse(
  text: string,
  sessionId: string,
  role: ChatMessage['role'],
  t: TFunction,
): {
  approved: boolean;
  decisionLabel: string;
  summary: string;
  sessionId: string;
  proposedAgents: Array<{
    name: string;
    role: string;
    title: string;
    model: 'forge' | 'premium' | null;
  }>;
} | null {
  if (role !== 'assistant') return null;
  if (!text.includes('HIRING_DECISION:')) return null;
  if (text.includes('[[HIRING_BOOTSTRAP_HIDDEN]]')) return null;
  if (/modo:\s*hiring\s*plan\s*inicial/i.test(text)) return null;
  if (/voce\s+e\s+o\s+ceo\/orchestrator\s+do\s+workspace/i.test(text)) {
    return null;
  }
  const approved = /HIRING_DECISION:\s*APPROVED/i.test(text);
  // Agentes propostos NESTE plano (blocos <orkestral:create-agent ...>). Usado
  // pra decidir se ainda há agente novo a criar — sem isso, qualquer plano novo
  // (ex.: só o Frontend) era marcado "já contratado" se já houvesse outro agente.
  const proposedAgents: Array<{
    name: string;
    role: string;
    title: string;
    model: 'forge' | 'premium' | null;
  }> = [];
  const agentRx = /<orkestral:create-agent\s+([^>]+?)\s*\/?>(?:<\/orkestral:create-agent>)?/gi;
  let am: RegExpExecArray | null;
  while ((am = agentRx.exec(text)) !== null) {
    const attrs = am[1];
    const name = /name="([^"]*)"/i.exec(attrs)?.[1]?.trim() ?? '';
    const r = /role="([^"]*)"/i.exec(attrs)?.[1]?.trim() ?? '';
    const title = /title="([^"]*)"/i.exec(attrs)?.[1]?.trim() || r;
    const mRaw = /model="([^"]*)"/i.exec(attrs)?.[1]?.trim().toLowerCase();
    const model = mRaw === 'forge' ? 'forge' : mRaw === 'premium' ? 'premium' : null;
    if (name) proposedAgents.push({ name, role: r, title, model });
  }
  // O card substitui a mensagem inteira (TextPart dá return aqui), então o
  // summary é o ÚNICO conteúdo visível — não cortar, ou perde texto do agente.
  const summary = text
    .replace(/HIRING_DECISION:\s*(APPROVED|REJECTED)/gi, '')
    .replace(/<orkestral:create-agent[^>]*\/?>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    approved,
    decisionLabel: approved ? t('chat.hiring.approveHiring') : t('chat.hiring.skipForNow'),
    summary: summary || t('chat.hiring.planReceived'),
    sessionId,
    proposedAgents,
  };
}

type AttachmentData = Extract<MessagePart, { type: 'attachment' }>['attachment'];

/**
 * Grid de anexos no topo da mensagem (estilo AI SDK Elements): thumbnails
 * quadrados lado a lado. Imagens viram thumbnail clicável (abre lightbox com
 * zoom); outros tipos (doc, vídeo) mostram um ícone. O nome/tamanho fica no
 * tooltip pra manter os cards limpos e alinhados.
 */
function AttachmentGrid({ attachments }: { attachments: AttachmentData[] }) {
  const { t } = useT();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!lightboxSrc) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setLightboxSrc(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxSrc]);

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {attachments.map((a, i) => {
          const src = `data:${a.mime};base64,${a.data}`;
          const sizeKb = Math.max(1, Math.round(a.size / 1024));
          const title = `${a.name} · ${sizeKb} KB`;
          if (a.mime.startsWith('image/')) {
            return (
              <button
                key={i}
                type="button"
                title={title}
                onClick={() => {
                  setZoomed(false);
                  setLightboxSrc(src);
                }}
                className="group relative h-24 w-24 overflow-hidden rounded-xl border border-hairline-strong"
              >
                <img src={src} alt={a.name} className="h-full w-full object-cover" />
                <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition-colors group-hover:bg-black/30 group-hover:opacity-100">
                  <ZoomIn className="h-5 w-5 text-white" />
                </span>
              </button>
            );
          }
          return (
            <div
              key={i}
              title={title}
              className="flex h-24 w-24 flex-col items-center justify-center gap-1.5 rounded-xl border border-hairline-strong bg-surface-subtle p-2"
            >
              {a.mime.startsWith('video/') ? (
                <Film className="h-6 w-6 text-text-muted" />
              ) : (
                <FileText className="h-6 w-6 text-text-muted" />
              )}
              <span className="w-full truncate text-center text-[10px] text-text-secondary">
                {a.name}
              </span>
            </div>
          );
        })}
      </div>
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-8"
          onClick={() => setLightboxSrc(null)}
        >
          <button
            type="button"
            onClick={() => setLightboxSrc(null)}
            aria-label={t('chat.attachment.close')}
            className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-lg bg-white/10 text-white transition-colors hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setZoomed((z) => !z);
            }}
            className="flex max-h-full max-w-full items-center justify-center"
          >
            <img
              src={lightboxSrc}
              alt=""
              className={cn(
                'max-h-full max-w-full rounded-lg object-contain transition-transform duration-200',
                zoomed ? 'scale-[1.8] cursor-zoom-out' : 'cursor-zoom-in',
              )}
            />
          </button>
        </div>
      )}
    </>
  );
}

function ToolCluster({
  parts,
  t: tProp,
}: {
  parts: Extract<MessagePart, { type: 'tool-call' }>[];
  t?: TFunction;
}) {
  const { t: tHook } = useT();
  const t = tProp ?? tHook;
  const summary = parts.length > 0 ? summarizeToolActivity(parts, t) : null;

  return (
    <div className="flex w-full flex-col gap-1">
      {summary && (
        <ToolActivitySummary
          summary={summary}
          items={parts.map((part) => {
            const meta = getToolMeta(part, t);
            return {
              label: meta.label,
              detail: meta.description,
              status: part.status,
            };
          })}
        />
      )}
    </div>
  );
}

type ToolActivityCategory = 'file' | 'search' | 'command' | 'web' | 'edit' | 'kb' | 'other';

interface ToolActivitySummaryData {
  files: number;
  searches: number;
  commands: number;
  web: number;
  edits: number;
  /** Edições que FALHARAM (tool_result com is_error — ex.: "String to replace not found").
   *  NÃO entram em `edits`: o app não pode afirmar "Editou" o que não aplicou. */
  failedEdits: number;
  kb: number;
  running: boolean;
  activeLine?: string;
  activeCategory?: ToolActivityCategory;
}

function ToolActivitySummary({
  summary,
  items,
}: {
  summary: ToolActivitySummaryData;
  items: Array<{ label: string; detail: string; status?: 'pending' | 'done' | 'error' }>;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const lines = activitySummaryLines(summary, t);
  if (lines.length === 0) return null;
  const primary = summary.activeLine ?? lines[0];
  const rest = lines.slice(1);
  const icon =
    summary.activeCategory === 'web' ||
    (summary.web > 0 && summary.files === 0 && summary.commands === 0)
      ? Globe2
      : summary.activeCategory === 'search' ||
          (summary.searches > 0 && summary.files === 0 && summary.commands === 0)
        ? Search
        : Terminal;
  const Icon = icon;

  return (
    <div className="mb-1 flex w-full flex-col gap-1 pl-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex w-fit max-w-full items-center gap-2 rounded-md px-0 py-1 text-left text-[13px] text-text-muted transition hover:text-text-secondary"
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{summary.running ? <Shimmer>{primary}</Shimmer> : primary}</span>
        {!summary.activeLine && rest.length > 0 && (
          <span className="text-text-faint">· {rest.join(', ')}</span>
        )}
        {items.length > 0 && (
          <ChevronDown
            className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
          />
        )}
      </button>
      {open && (
        <div className="ml-6 flex max-w-[680px] flex-col gap-1 border-l border-hairline-strong pl-3">
          {items.map((item, index) => (
            <div key={index} className="flex min-w-0 items-center gap-2 text-[12px]">
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  item.status === 'error'
                    ? 'bg-accent-red'
                    : item.status === 'pending'
                      ? 'bg-accent-purple'
                      : 'bg-white/30',
                )}
              />
              <span className="w-16 shrink-0 truncate text-text-faint">{item.label}</span>
              <span className="min-w-0 flex-1 truncate text-text-muted" title={item.detail}>
                {item.detail}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function summarizeToolActivity(
  parts: Extract<MessagePart, { type: 'tool-call' }>[],
  t: TFunction,
): ToolActivitySummaryData {
  const files = new Set<string>();
  const summary: ToolActivitySummaryData = {
    files: 0,
    searches: 0,
    commands: 0,
    web: 0,
    edits: 0,
    failedEdits: 0,
    kb: 0,
    running: parts.some((part) => part.status === 'pending'),
  };

  for (const part of parts) {
    const category = toolActivityCategory(part.toolName);
    const meta = getToolMeta(part, t);
    // Tool que FALHOU (tool_result is_error — ex.: Edit cujo texto-alvo não casou) NÃO conta
    // como sucesso: senão o app afirma "Editou 1 arquivo" pra uma edição que não aconteceu.
    if (part.status === 'error') {
      if (category === 'edit') summary.failedEdits += 1;
      continue;
    }
    if (category === 'file') files.add(meta.description);
    else if (category === 'search') summary.searches += 1;
    else if (category === 'command') summary.commands += 1;
    else if (category === 'web') summary.web += 1;
    else if (category === 'edit') summary.edits += 1;
    else if (category === 'kb') summary.kb += 1;
    else summary.searches += 1;

    if (part.status === 'pending') {
      summary.activeCategory = category;
      summary.activeLine = liveToolActivityLine(category, meta, t);
    }
  }
  summary.files = files.size;
  return summary;
}

function liveToolActivityLine(
  category: ToolActivityCategory,
  meta: { label: string; description: string },
  t: TFunction,
): string {
  const detail = meta.description.trim();
  if (category === 'search') {
    return detail
      ? t('chat.activity.searchingInFolder', { detail })
      : t('chat.activity.searchingFiles');
  }
  if (category === 'file') {
    return detail ? t('chat.activity.reading', { detail }) : t('chat.activity.readingFiles');
  }
  if (category === 'edit') {
    return detail ? t('chat.activity.editing', { detail }) : t('chat.activity.editingFiles');
  }
  if (category === 'command') {
    return detail ? t('chat.activity.running', { detail }) : t('chat.activity.runningCommand');
  }
  if (category === 'web') {
    return detail
      ? t('chat.activity.searchingWebFor', { detail })
      : t('chat.activity.searchingWeb');
  }
  if (category === 'kb') {
    return detail ? t('chat.activity.searchingKbFor', { detail }) : t('chat.activity.searchingKb');
  }
  return detail ? `${meta.label} ${detail}` : meta.label;
}

function toolActivityCategory(toolName: string): ToolActivityCategory {
  const raw = toolName.toLowerCase();
  if (raw.includes('bash') || raw.includes('command') || raw.includes('terminal')) return 'command';
  if (raw.includes('web') || raw.includes('fetch_url') || raw.includes('browser')) return 'web';
  if (raw.includes('kb_') || raw.includes('knowledge')) return 'kb';
  if (raw.includes('grep') || raw.includes('glob') || raw.includes('search')) return 'search';
  if (raw.includes('apply_patch') || raw.includes('edit') || raw.includes('write')) return 'edit';
  if (raw.includes('read') || raw.includes('list') || raw.includes('get_')) return 'file';
  return 'other';
}

function activitySummaryLines(summary: ToolActivitySummaryData, t: TFunction): string[] {
  const lines: string[] = [];
  const exploredParts: string[] = [];
  if (summary.files > 0) {
    exploredParts.push(
      t(summary.files === 1 ? 'chat.activity.file' : 'chat.activity.files', { n: summary.files }),
    );
  }
  if (summary.searches > 0) {
    exploredParts.push(
      t(summary.searches === 1 ? 'chat.activity.search' : 'chat.activity.searches', {
        n: summary.searches,
      }),
    );
  }
  if (summary.commands > 0) {
    const commandLabel = t(
      summary.commands === 1 ? 'chat.activity.ranCommand' : 'chat.activity.ranCommands',
      { n: summary.commands },
    );
    if (exploredParts.length > 0) exploredParts.push(commandLabel);
    else lines.push(commandLabel.charAt(0).toUpperCase() + commandLabel.slice(1));
  }
  if (exploredParts.length > 0)
    lines.push(t('chat.activity.explored', { parts: exploredParts.join(', ') }));
  if (summary.web > 0) {
    lines.push(
      summary.web === 1
        ? t('chat.activity.searchedWebOnce')
        : t('chat.activity.searchedWebMany', { n: summary.web }),
    );
  }
  if (summary.kb > 0) {
    lines.push(
      summary.kb === 1
        ? t('chat.activity.searchedKbOnce')
        : t('chat.activity.searchedKbMany', { n: summary.kb }),
    );
  }
  if (summary.edits > 0) {
    lines.push(
      t(summary.edits === 1 ? 'chat.activity.editedFile' : 'chat.activity.editedFiles', {
        n: summary.edits,
      }),
    );
  }
  // Edições que NÃO aplicaram (texto-alvo não casou etc.) — surfaçadas em vez de fingir sucesso.
  if (summary.failedEdits > 0) {
    lines.push(
      t(
        summary.failedEdits === 1 ? 'chat.activity.editFailedOne' : 'chat.activity.editFailedMany',
        { n: summary.failedEdits },
      ),
    );
  }
  return lines;
}

/** Abrevia path longo mostrando só os últimos 2 segmentos relevantes. */
function shortenPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return '…/' + parts.slice(-2).join('/');
}

/**
 * Humaniza nome técnico das tools pra texto curto e legível no chat.
 * Sem prefixo `mcp__orkestral__`, sem snake_case feio.
 */
function humanizeToolName(raw: string, t: TFunction): string {
  const stripped = raw
    .replace(/^mcp__[^_]+__/, '')
    .replace(/^mcp_/, '')
    .replace(/^orkestral_/, '');
  const map: Record<string, string> = {
    Read: t('chat.tools.readingFile'),
    Write: t('chat.tools.writingFile'),
    Edit: t('chat.tools.editingFile'),
    Glob: t('chat.tools.searchingFiles'),
    Grep: t('chat.tools.searchingText'),
    Bash: t('chat.tools.shellCommand'),
    ToolSearch: t('chat.tools.tools'),
    list_agents: t('chat.tools.listingAgents'),
    list_sources: t('chat.tools.listingSources'),
    list_issues: t('chat.tools.listingIssues'),
    create_issue: t('chat.tools.creatingIssue'),
    update_issue: t('chat.tools.updatingIssue'),
    update_issue_status: t('chat.tools.updatingStatus'),
    comment_on_issue: t('chat.tools.commentingIssue'),
    get_issue: t('chat.tools.readingIssue'),
    get_workspace_info: t('chat.tools.workspaceContext'),
    kb_search: t('chat.tools.searchingKb'),
    kb_get_page: t('chat.tools.readingKbPage'),
    kb_get_page_tree: t('chat.tools.kbTree'),
    kb_create_page: t('chat.tools.creatingKbPage'),
    kb_link_pages: t('chat.tools.linkingPages'),
    kb_get_backlinks: t('chat.tools.backlinks'),
  };
  return map[stripped] ?? stripped.replace(/_/g, ' ');
}

function getToolMeta(
  part: Extract<MessagePart, { type: 'tool-call' }>,
  t: TFunction,
): {
  label: string;
  description: string;
  plus: number;
  minus: number;
} {
  const raw = part.toolName.toLowerCase();
  const args = part.args ?? {};

  // Os CLIs usam convenções diferentes (claude: snake_case, codex: camelCase
  // ou patchText). Tentamos as duas pra não perder o argumento útil.
  const asString = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v : undefined;
  const filePathArg =
    asString(args.file_path) ??
    asString(args.filePath) ??
    asString(args.path) ??
    asString(args.dir) ??
    asString(args.directory) ??
    asString(args.target_directory) ??
    asString(args.url);
  const patternArg = asString(args.pattern) ?? asString(args.glob) ?? asString(args.query);

  if (raw.includes('bash')) {
    const description =
      asString(args.command) ?? asString(args.description) ?? t('chat.tools.shellDefault');
    return {
      label: t('chat.tools.shellLabel'),
      description: shortenForDisplay(description),
      plus: 0,
      minus: 0,
    };
  }

  if (raw.includes('apply_patch') || raw.includes('edit') || raw.includes('write')) {
    const patch = asString(args.patchText) ?? '';
    const path = extractFirstPatchedPath(patch) ?? filePathArg ?? t('chat.tools.fileFallback');
    const counts = countEditDelta(args, patch);
    return {
      label: raw.includes('edit') ? 'Edit' : raw.includes('write') ? 'Write' : 'Patch',
      description: shortenPath(path),
      plus: counts.plus,
      minus: counts.minus,
    };
  }

  if (raw.includes('read')) {
    return {
      label: 'Read',
      description: filePathArg ? shortenPath(filePathArg) : t('chat.tools.fileFallback'),
      plus: 0,
      minus: 0,
    };
  }

  if (raw.includes('grep')) {
    const pattern = patternArg ?? t('chat.tools.patternFallback');
    const where = filePathArg ? t('chat.tools.grepWhere', { path: shortenPath(filePathArg) }) : '';
    return { label: 'Grep', description: `${pattern}${where}`, plus: 0, minus: 0 };
  }

  if (raw.includes('glob') || raw.includes('list')) {
    const pattern = patternArg ?? filePathArg ?? t('chat.tools.filesFallback');
    return {
      label: raw.includes('glob') ? 'Glob' : 'List',
      description: shortenForDisplay(pattern),
      plus: 0,
      minus: 0,
    };
  }

  // ToolSearch / deferred-tool lookup é um mecanismo INTERNO. O payload bruto
  // (`select:list_agents,list_sources,…`) é ruído — mostramos um rótulo limpo
  // sem expor o argumento.
  const rawQuery = asString(args.query) ?? asString(args.q);
  if (raw.includes('toolsearch') || (rawQuery?.startsWith('select:') ?? false)) {
    return {
      label: t('chat.tools.tools'),
      description: t('chat.tools.toolSearchDescription'),
      plus: 0,
      minus: 0,
    };
  }

  // MCP / outras tools (create_issue, kb_*, comment_on_issue…): rótulo legível
  // + o argumento útil (título, query, #issue) em vez de "Execução de ferramenta".
  const stripped = part.toolName
    .replace(/^mcp__[^_]+__/, '')
    .replace(/^mcp_/, '')
    .replace(/^orkestral_/, '');
  const title = asString(args.title) ?? asString(args.name);
  const query = rawQuery;
  const issueKey =
    typeof args.issue_key === 'number' ? `#${args.issue_key}` : asString(args.issue_key);
  const detail = title ?? query ?? issueKey ?? asString(args.page_id) ?? '';
  return {
    label: humanizeToolName(part.toolName, t),
    description: detail ? shortenForDisplay(detail) : labelHint(stripped, t),
    plus: 0,
    minus: 0,
  };
}

/** Descrição genérica curta por família de tool, quando não há argumento útil. */
function labelHint(stripped: string, t: TFunction): string {
  if (stripped.startsWith('list_')) return t('chat.tools.hintQuerying');
  if (stripped.startsWith('get_') || stripped.startsWith('kb_get'))
    return t('chat.tools.hintReading');
  return '';
}

/** Trunca string longa pra exibição compacta no cluster. */
function shortenForDisplay(s: string): string {
  if (s.length <= 80) return s;
  return s.slice(0, 77) + '…';
}

function countLines(value: string | undefined): number {
  if (!value) return 0;
  const normalized = value.replace(/\n$/, '');
  if (!normalized) return 0;
  return normalized.split('\n').length;
}

function countEditDelta(
  args: Record<string, unknown>,
  patchText: string,
): { plus: number; minus: number } {
  const asString = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v : undefined;
  if (patchText.trim()) {
    return {
      plus: (patchText.match(/^\+(?!\+\+|\*\*\*)/gm) ?? []).length,
      minus: (patchText.match(/^-(?!--|\*\*\*)/gm) ?? []).length,
    };
  }

  const oldText = asString(args.old_string) ?? asString(args.oldString);
  const newText = asString(args.new_string) ?? asString(args.newString);
  if (oldText || newText) {
    return {
      plus: countLines(newText),
      minus: countLines(oldText),
    };
  }

  const content = asString(args.content) ?? asString(args.text);
  return { plus: countLines(content), minus: 0 };
}

function extractFirstPatchedPath(patchText: string): string | null {
  const match = patchText.match(/\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
  return match?.[1]?.trim() ?? null;
}

// ============================================================================
// Hover actions
// ============================================================================

function CopyButton({ text }: { text: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      console.error('[copy] falhou', err);
    }
  }

  return (
    <HoverAction onClick={copy} title={t('chat.message.copy')}>
      {copied ? <Check className="h-3 w-3 text-accent-green" /> : <Copy className="h-3 w-3" />}
    </HoverAction>
  );
}

function HoverAction({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="grid h-5 w-5 place-items-center rounded text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
    >
      {children}
    </button>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function StreamingCursor({ inline }: { inline?: boolean }) {
  return (
    <span
      className={cn(
        'inline-block h-3.5 w-[2px] animate-pulse-dot bg-text-primary align-middle',
        inline ? 'ml-0.5' : '',
      )}
    />
  );
}

/**
 * Indicador "trabalhando" estilo Claude Code: um verbo único com brilho
 * (shimmer) varrendo + reticências, trocando o verbo a cada ~2.4s. Substitui os
 * 3 pontinhos por um feedback claro de que o agente está processando.
 */
const WORKING_VERB_KEYS = [
  'chat.typing.thinking',
  'chat.typing.processing',
  'chat.typing.working',
  'chat.typing.analyzing',
  'chat.typing.organizing',
];

function TypingDots({ hint, liveLabel }: { hint?: string; liveLabel?: string | null }) {
  const { t } = useT();
  const [i, setI] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const verb = setInterval(() => setI((v) => (v + 1) % WORKING_VERB_KEYS.length), 2400);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(verb);
      clearInterval(clock);
    };
  }, []);
  const elapsedSec = Math.floor((now - startedAt) / 1000);
  const mm = Math.floor(elapsedSec / 60);
  const ss = elapsedSec % 60;
  // Watchdog: depois de 30s sem nada renderizado, mostra o tempo + dica de que
  // tarefas pesadas (ler o repo, propor o time) levam até ~1 min.
  const showElapsed = elapsedSec >= 30;
  // Com `hint` (ex.: contexto de contratação), mostra um rótulo fixo e claro em
  // vez de ciclar verbos genéricos — o usuário sabe O QUE o agente está fazendo.
  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-2 text-[13.5px]">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" />
        {/* Prioridade: fase VIVA do stream (o que o agente está fazendo AGORA) >
            hint fixo do contexto > verbos genéricos ciclando. */}
        <Shimmer>{liveLabel ?? (hint ? t(hint) : t(WORKING_VERB_KEYS[i]))}…</Shimmer>
        {showElapsed && (
          <span className="text-[11.5px] tabular-nums text-text-faint">
            · {mm > 0 ? `${mm}m ` : ''}
            {ss}s
          </span>
        )}
      </div>
      {showElapsed && (
        <span className="text-[11.5px] leading-snug text-text-faint">
          {t('chat.typing.longHint')}
        </span>
      )}
    </div>
  );
}
