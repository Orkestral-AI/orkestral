import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { Message } from './Message';
import { coalesceToolOnlyMessages } from './coalesce-tool-messages';
import { isHiddenPlanningMessage } from './ask-user';
import { formatTime } from '@renderer/lib/time';
import { cn } from '@renderer/lib/utils';
import type { Agent, ChatMessage } from '@shared/types';

interface MessageListProps {
  messages: ChatMessage[];
  userName?: string;
  agentName?: string;
  /** Seed do avatar do agente — usada pra renderizar AgentAvatar nas mensagens. */
  agentAvatarSeed?: string | null;
  /** Lista completa de agentes do workspace — usada pra detectar @mentions no texto. */
  allAgents?: Agent[];
  /** Metadata da última mensagem do user (Build · model · time). */
  buildLabel?: string;
  modelLabel?: string;
  /** Painel aberto → o chat preenche a coluna (sem a centralização estreita). */
  expand?: boolean;
  /** Superfície estreita (popover da IDE) → padding/gaps menores nas mensagens. */
  compact?: boolean;
  /** Conteúdo renderizado DEPOIS das mensagens (ex.: card de execução do plano).
   *  Rola junto com o chat e participa do auto-scroll. */
  footer?: ReactNode;
}

/**
 * Lista de mensagens. Faz auto-scroll pro fim quando novas mensagens chegam
 * OU quando o stream da última mensagem está atualizando.
 */
export function MessageList({
  messages,
  agentName,
  agentAvatarSeed,
  allAgents,
  userName,
  buildLabel,
  modelLabel,
  expand,
  compact,
  footer,
}: MessageListProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const lastLengthRef = useRef(0);
  const lastTextRef = useRef('');
  // 1ª posição já feita? Evita re-disparar o salto inicial. (P0-01)
  const didInitialScrollRef = useRef(false);
  // O usuário está "grudado" no fim? Atualizado no onScroll: se ele rolou pra cima
  // pra ler mensagens antigas, novas mensagens NÃO sequestram o scroll (P0-01).
  const stickToBottomRef = useRef(true);

  // Cards de exploração consecutivos viram UM só (resumo, não muro repetido). Só pra
  // RENDER — os efeitos de scroll seguem nas mensagens cruas (gatilho por novidade).
  const displayMessages = useMemo(() => {
    // Esconde a mensagem de respostas do wizard de planejamento (o CEO lê, o usuário
    // vê o card de decisões no próprio wizard, não uma bolha crua "Minhas decisões").
    const visible = messages.filter((m) => {
      const txt = m.parts.find((p) => p.type === 'text');
      return !(txt?.type === 'text' && isHiddenPlanningMessage(txt.text));
    });
    return coalesceToolOnlyMessages(visible);
  }, [messages]);

  const lastTextOf = (msgs: ChatMessage[]): string | undefined =>
    (msgs[msgs.length - 1]?.parts.find((p) => p.type === 'text') as { text: string } | undefined)
      ?.text;

  const firstTextValue = (m: ChatMessage): string => {
    const p = m.parts.find((x) => x.type === 'text');
    return p?.type === 'text' ? p.text : '';
  };
  // Resposta a um prompt de contratação inicial? (a msg user anterior é o
  // bootstrap do CEO). Usado pra mostrar "Lendo o repositório pra propor o time"
  // em vez do verbo genérico enquanto o CEO processa (até ~1 min).
  const isHiringBootstrapPrompt = (v: string): boolean =>
    v.includes('[[HIRING_BOOTSTRAP_HIDDEN]]') ||
    v.includes('Modo: HIRING PLAN INICIAL') ||
    v.includes('Você é o CEO/Orchestrator do workspace');

  // Posicionamento INICIAL: instantâneo e ANTES do primeiro paint visível (sem a
  // animação descendo do topo). useLayoutEffect roda após o DOM montar e antes do
  // browser pintar — o histórico já aparece no fim. (P0-01)
  useLayoutEffect(() => {
    if (didInitialScrollRef.current || messages.length === 0) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight; // salto instantâneo, sem smooth
    didInitialScrollRef.current = true;
    stickToBottomRef.current = true;
    lastLengthRef.current = messages.length;
    const lastText = lastTextOf(messages);
    if (typeof lastText === 'string') lastTextRef.current = lastText;
  }, [messages]);

  // Novas mensagens / streaming: smooth, MAS só se o usuário já estava no fim.
  useEffect(() => {
    if (!didInitialScrollRef.current || !endRef.current) return;
    const lastText = lastTextOf(messages);
    const grew =
      messages.length !== lastLengthRef.current ||
      (typeof lastText === 'string' && lastText !== lastTextRef.current);
    if (grew) {
      if (stickToBottomRef.current) {
        endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
      lastLengthRef.current = messages.length;
      if (typeof lastText === 'string') lastTextRef.current = lastText;
    }
  }, [messages]);

  const handleScroll = (): void => {
    const el = scrollerRef.current;
    if (!el) return;
    // Tolerância de 120px: "perto do fim" conta como grudado.
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // ANTI-JUMP: quando algo ACIMA cresce (ex.: o painel "Analisando suas sources"
  // streamando tools), o conteúdo empurra e o chat "pula". Se o usuário está
  // grudado no fim, refixamos no fundo INSTANTANEAMENTE (sem smooth) a cada
  // mudança de altura — o chat fica embaixo, parado, sem saltos.
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollerRef.current;
    if (!content || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      className="no-scrollbar relative flex flex-1 flex-col overflow-y-auto"
    >
      <div
        ref={contentRef}
        className={cn('chat-width-col mx-auto w-full', expand ? 'max-w-5xl px-6' : 'max-w-3xl')}
      >
        {displayMessages.map((m, idx) => {
          // Metadata visível em AMBOS user e assistant pra dar contexto de
          // build/modelo/horário em qualquer ponto do histórico.
          //   user → "Build · modelo · 19:51"
          //   assistant → "@CEO · modelo · 19:51"
          const metadata =
            m.role === 'user'
              ? [buildLabel ?? 'Build', modelLabel, formatTime(m.createdAt)]
                  .filter(Boolean)
                  .join(' · ')
              : [agentName ? `@${agentName}` : null, modelLabel, formatTime(m.createdAt)]
                  .filter(Boolean)
                  .join(' · ');
          const prev = idx > 0 ? displayMessages[idx - 1] : undefined;
          const typingHint =
            m.role === 'assistant' &&
            prev?.role === 'user' &&
            isHiringBootstrapPrompt(firstTextValue(prev))
              ? 'chat.typing.hiringHint'
              : undefined;
          return (
            <Message
              key={m.id}
              message={m}
              metadata={metadata}
              agentName={agentName}
              agentAvatarSeed={agentAvatarSeed}
              allAgents={allAgents}
              userName={userName}
              typingHint={typingHint}
              compact={compact}
            />
          );
        })}
        {footer && <div className="px-6 pt-1">{footer}</div>}
        <div ref={endRef} className="h-4" />
      </div>
    </div>
  );
}
