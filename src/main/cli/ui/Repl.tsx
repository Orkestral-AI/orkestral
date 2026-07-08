import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useAnimation, useApp, useInput } from 'ink';
import { Welcome } from './Welcome';
import { InitWizard } from './InitWizard';
import { Selector, type SelectItem } from './Selector';
import { StreamAccumulator, type StreamBlock } from './stream-render';
import { CommandAutocomplete } from './CommandAutocomplete';
import { FileAutocomplete } from './FileAutocomplete';
import { MarkdownText } from './MarkdownText';
import { filterCommands } from './command-filter';
import { activeMentionToken, filterFiles, loadWorkspaceFiles } from '../file-mentions';
import { ChannelConnect } from './ChannelConnect';
import { WorkspaceCreate } from './WorkspaceCreate';
import { TextInput } from './input/TextInput';
import { applyKeyToBuffer } from './input/text-edit';
import { UserRepository } from '../../db/repositories/user.repo';
import { buildHelpText, parseInput } from '../commands';
import { collectStatus, formatStatusText } from '../status';
import { newSession, clearSession, compactSession, listAgents } from '../actions';
import {
  collectSetupIssues,
  messagesToTurns,
  resolveBootSession,
  type HistoryTurn,
} from '../repl-boot';
import { getPermissionMode, setPermissionMode, type PermissionMode } from '../permission';
import { appendHistory, loadHistory, pushLine, HISTORY_CAP } from '../history-store';
import { listEditableConfigs, type EditableConfig } from '../config-editor';
import { chatStreamBus, cancelRun, enqueueChatMessage } from '../../services/chat-service';
import {
  approvalBus,
  resolveApproval,
  type ApprovalRequest,
} from '../../services/permission-approvals';
import { AgentRepository } from '../../db/repositories/agent.repo';
import { AgentRunRepository } from '../../db/repositories/run.repo';
import { MessageRepository } from '../../db/repositories/message.repo';
import { ChatSessionRepository } from '../../db/repositories/session.repo';
import { WorkspaceRepository } from '../../db/repositories/workspace.repo';
import { SettingsRepository } from '../../db/repositories/settings.repo';
import { getAdapter } from '../../adapters/registry';
import type { Agent, ChatStreamEvent, MessagePart } from '../../../shared/types';

/**
 * Contagem de tokens legível pro `/cost` e pro ctx% do footer: abaixo de mil
 * mostra cru; depois `12.3k`/`1.2M` (uma casa, sem zero à direita — `12k`).
 */
function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  const scaled = n < 1_000_000 ? n / 1000 : n / 1_000_000;
  const suffix = n < 1_000_000 ? 'k' : 'M';
  const rounded = Math.round(scaled * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`;
}

/**
 * Nota multi-linha do `/cost`: agregado da sessão (uma query de SUM/COUNT no
 * repo). O caveat de custo é honesto — só runs do adapter claude persistem
 * usage/custo (codex/forge ficam NULL e caem fora do SUM).
 */
function buildCostText(usage: {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  runs: number;
}): string {
  return [
    'custo da sessão',
    `  runs:       ${usage.runs}`,
    `  tokens in:  ${formatTokenCount(usage.tokensIn)}`,
    `  tokens out: ${formatTokenCount(usage.tokensOut)}`,
    `  custo:      $${usage.costUsd.toFixed(4)} (custo só em runs claude)`,
  ].join('\n');
}

/** Máximo de sessões listadas no picker do /resume. */
const RESUME_PICKER_MAX = 20;
/** Truncamento do título (label) e do preview (meta) no picker do /resume. */
const RESUME_TITLE_MAX = 40;
const RESUME_PREVIEW_MAX = 30;

/** Corta em `max` chars com reticência — nunca estoura a linha do Selector. */
function truncateLine(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Idade relativa curta pro picker: `agora`, `5min`, `3h`, `2d`. */
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'agora';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Itens do picker do `/resume`: sessões recentes do workspace (não-arquivadas,
 * fora de canal — conversa de WhatsApp/etc. pertence ao canal), cap de 20.
 * Por sessão: título truncado + `idade · N msgs · preview` (primeiro bloco de
 * texto da ÚLTIMA mensagem). Duas queries mínimas por sessão (COUNT + LIMIT 1)
 * — no máx. 40 leituras pontuais indexadas, só quando o usuário abre o picker.
 */
function buildResumeItems(workspaceId: string, currentSessionId: string): SelectItem[] {
  const sessions = new ChatSessionRepository()
    .listByWorkspace(workspaceId)
    .filter((s) => !s.channelType)
    .slice(0, RESUME_PICKER_MAX);
  const messageRepo = new MessageRepository();
  return sessions.map((s) => {
    const count = messageRepo.countBySession(s.id);
    const last = messageRepo.lastBySession(s.id);
    const lastText =
      last?.parts.find((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
        ?.text ?? '';
    const preview = truncateLine(lastText.replace(/\s+/g, ' ').trim(), RESUME_PREVIEW_MAX);
    return {
      id: s.id,
      label: truncateLine(s.title, RESUME_TITLE_MAX),
      meta: [relativeTime(s.updatedAt), `${count} msgs`, preview]
        .filter((part) => part.length > 0)
        .join(' · '),
      current: s.id === currentSessionId,
    };
  });
}

/** Junta os blocos de texto de um turn (user/note têm um bloco só). */
function turnText(turn: HistoryTurn): string {
  return turn.blocks
    .filter((b): b is Extract<StreamBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('\n');
}

/** Estado vivo de um run em andamento — o acumulador + um snapshot pro render. */
interface StreamingState {
  acc: StreamAccumulator;
  runId: string;
  messageId: string;
  blocks: readonly StreamBlock[];
  /** Label da fase atual do run (evento `phase`) — null antes da primeira. */
  phase: string | null;
  /**
   * Timestamp (ms) do último evento do bus aplicado a ESTE run. Mutado direto
   * no listener (como o `acc`) — não dispara render; serve pra detectar run
   * órfão quando um `message-start` novo chega com este stream ainda aberto.
   */
  lastEventAt: number;
  /** Cancel já pedido (Esc): o spinner vira "cancelando…" e Esc repetido é no-op. */
  cancelling?: boolean;
}

/** Sem eventos há mais que isso = run órfão; um `message-start` novo pode adotar. */
const STALE_RUN_MS = 120_000;

/** Janela de contexto assumida pro ctx% do footer (modelos claude atuais). */
const CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000;

/** Modo global de detalhe das tools no transcript (Ctrl+O cicla). */
type ToolDetailMode = 'off' | 'preview';

/** Duração do flash "tools: preview" no StatusLine após o Ctrl+O. */
const TOOL_DETAIL_FLASH_MS = 2000;

type Overlay =
  | { kind: 'agent'; items: SelectItem[] }
  | { kind: 'workspace'; items: SelectItem[] }
  | { kind: 'model'; items: SelectItem[] }
  | { kind: 'permissions'; items: SelectItem[] }
  | { kind: 'config'; items: SelectItem[]; configs: EditableConfig[] }
  | { kind: 'config-value'; items: SelectItem[]; config: EditableConfig }
  | { kind: 'resume'; items: SelectItem[] }
  | { kind: 'channels' }
  | { kind: 'workspace-create' }
  | { kind: 'approval'; req: ApprovalRequest };

/** Sentinela usada como id da entrada "+ criar novo workspace" no overlay. */
const WORKSPACE_CREATE_ID = '__new_workspace__';

/** Janela do throttle de text-deltas: no máx. 1 re-render a cada ~50ms. */
const DELTA_FLUSH_MS = 50;

/** Item do transcript estático: o banner de boas-vindas ou um turn fechado. */
type TranscriptItem =
  | { id: string; kind: 'welcome' }
  | { id: string; kind: 'turn'; turn: HistoryTurn };

const PERMISSION_MODES: { mode: PermissionMode; label: string }[] = [
  { mode: 'default', label: 'default — segue a SpawnPolicy' },
  { mode: 'acceptEdits', label: 'acceptEdits — aceita edições (claude only)' },
  { mode: 'plan', label: 'plan — só planeja (claude only)' },
  { mode: 'dangerously-skip', label: 'dangerously-skip — full-auto' },
];

/**
 * Sufixo honesto pros modos que só têm efeito no adapter claude
 * (`--permission-mode`): o Codex CLI não tem flag equivalente, então em agentes
 * codex `acceptEdits`/`plan` não mudam nada no spawn.
 */
function claudeOnlyHint(mode: PermissionMode): string {
  return mode === 'acceptEdits' || mode === 'plan' ? ' (claude only)' : '';
}

/**
 * REPL interativo do `orkestral` (default command). Resolve uma sessão atual no
 * boot (workspace ativo + agente orquestrador) e dá um loop conversacional com
 * streaming ao vivo, comandos `/` (overlays com Selector) e um footer de status.
 *
 * Sem deps de input externas: o campo de texto é um `useInput` controlado, igual
 * ao InitWizard. Tudo síncrono via repos (better-sqlite3); só `enqueueChatMessage`
 * e `/compact` são async.
 */
export function Repl({
  forceNewSession = false,
  initialResumePicker = false,
}: {
  /** `--new` da CLI: não retoma a última sessão — cria uma nova direto. */
  forceNewSession?: boolean;
  /** `--resume` da CLI: abre o REPL já com o picker de sessões recentes. */
  initialResumePicker?: boolean;
}): React.ReactElement {
  const { exit } = useApp();

  // Resolve a sessão inicial UMA vez via initializer de useState (roda só no
  // primeiro render, fora do corpo "puro" — não é um useMemo com efeito). Falha
  // amigável (sem workspace/agente) cai num estado de "setup" que renderiza a
  // dica de `orkestral init`.
  const [boot] = useState(() => resolveBootSession(forceNewSession));

  const needsSetup = !boot.ok;

  const [workspaceId, setWorkspaceId] = useState(() => (boot.ok ? boot.workspaceId : ''));
  const [agentId, setAgentId] = useState(() => (boot.ok ? boot.agentId : ''));
  const [sessionId, setSessionId] = useState(() => (boot.ok ? boot.sessionId : ''));
  // Semeado com o histórico da sessão retomada (vazio quando a sessão é nova).
  const [history, setHistory] = useState<HistoryTurn[]>(() => (boot.ok ? boot.turns : []));
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  // `--resume`: nasce direto no picker de sessões (initializer, igual ao boot —
  // leitura síncrona dos repos uma vez, nada de setState em effect).
  const [overlay, setOverlay] = useState<Overlay | null>(() =>
    initialResumePicker && boot.ok
      ? { kind: 'resume', items: buildResumeItems(boot.workspaceId, boot.sessionId) }
      : null,
  );
  // tokensIn do ÚLTIMO run fechado (input + cache) — vira o `ctx ~N%` do
  // footer. null antes do primeiro run (indicador omitido) e ao trocar de
  // sessão/limpar (contexto recomeça).
  const [ctxTokens, setCtxTokens] = useState<number | null>(null);
  const [input, setInput] = useState('');
  // Posição do cursor DENTRO do input (0..len) — edição real via applyKeyToBuffer.
  const [cursor, setCursor] = useState(0);
  // Linhas pendentes da continuação multi-linha: Enter numa linha terminando em
  // `\` não submete — tira o `\`, guarda a linha aqui (mostrada dim acima do
  // input, prefixo `…`) e o Enter seguinte SEM `\` envia tudo junto (join com
  // \n). Esc-Esc descarta pendentes + input.
  const [pendingLines, setPendingLines] = useState<string[]>([]);
  // Índice destacado no popup de autocomplete ativo (slash OU @arquivo — nunca
  // há dois ao mesmo tempo, então um estado só serve os dois).
  const [acIndex, setAcIndex] = useState(0);
  // Popup de autocomplete suprimido (slash e @arquivo): Esc fecha SÓ o popup
  // primeiro (sem cancelar run/sair) e o recall de histórico (↑/↓) mantém
  // fechado mesmo com `/` no input. Digitar/apagar (mudança de TEXTO vinda do
  // teclado) reabre.
  const [acClosed, setAcClosed] = useState(false);
  // Época do transcript estático: `<Static>` só anda pra frente (índice interno
  // de itens já impressos), então RESETAR o history exige REMONTAR o Static
  // (key nova) — senão os turns pós-reset ficariam abaixo do índice antigo e
  // nunca seriam impressos. Incrementada em todo lugar que zera o history.
  const [transcriptEpoch, setTranscriptEpoch] = useState(0);

  // Histórico de mensagens enviadas (mais recente por último) pra navegar com
  // ↑/↓ — só as mensagens do usuário, na ordem de envio. `histNav` aponta o item
  // em foco: índice no array, ou `null` quando não estamos navegando (input livre).
  // Semeado do arquivo persistente UMA vez no boot (initializer de useState, igual
  // ao `boot`) — cada submit anexa lá também, então o ↑ recupera entre sessões.
  const [bootHistory] = useState<string[]>(() => loadHistory());
  const sentHistoryRef = useRef<string[]>(bootHistory);
  const histNavRef = useRef<number | null>(null);
  // Esc-Esc pra limpar o input: o 1º Esc "arma" (timestamp), o 2º (dentro da
  // janela) limpa. Qualquer outra tecla desarma. Vale só quando ocioso e sem
  // popup — streaming/popup têm precedência no Esc (cancelar run / fechar popup).
  const escArmedAtRef = useRef<number | null>(null);
  const ESC_ESC_WINDOW_MS = 600;

  // Desarma o gatilho de Esc-Esc e zera a navegação de histórico — chamado sempre
  // que o usuário digita/apaga/submete (qualquer interação que não seja o 2º Esc).
  const resetInputNavState = useCallback(() => {
    histNavRef.current = null;
    escArmedAtRef.current = null;
  }, []);

  // Snapshot do agente em state (não memo): precisa ser refrescado também quando
  // SÓ o modelo muda (`/model`) — aí não há mudança de agentId/sessionId pra
  // disparar um memo. `refreshAgent()` relê do repo e re-renderiza o footer.
  const [agent, setAgent] = useState<Agent | null>(() =>
    boot.ok ? new AgentRepository().get(boot.agentId) : null,
  );
  const refreshAgent = useCallback((id: string) => {
    setAgent(id ? new AgentRepository().get(id) : null);
  }, []);
  const workspaceName = useMemo(
    () => new WorkspaceRepository().listAll().find((w) => w.id === workspaceId)?.name ?? '—',
    [workspaceId],
  );
  const [permMode, setPermMode] = useState<PermissionMode>(() => getPermissionMode());
  // Detalhe global das tools (Ctrl+O): 'off' = só a linha ⏺ (default);
  // 'preview' = + primeiras 3 linhas do output, dim e indentadas. Só em memória
  // (dura a sessão do processo). Vale pro stream vivo e pros turns IMPRESSOS
  // depois do toggle — o <Static> não reimprime o que já saiu no terminal.
  const [toolDetail, setToolDetail] = useState<ToolDetailMode>('off');
  // Flash transiente do StatusLine quando o modo é alternado ("tools: preview").
  const [toolDetailFlash, setToolDetailFlash] = useState(false);
  const toolFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ctrl+O: cicla o detalhe das tools (off → preview → off). O feedback é o
  // flash de ~2s no StatusLine em vez de nota no transcript — toggle visual
  // não precisa virar história no scrollback.
  const cycleToolDetail = useCallback(() => {
    setToolDetail((d) => (d === 'off' ? 'preview' : 'off'));
    setToolDetailFlash(true);
    if (toolFlashTimerRef.current) clearTimeout(toolFlashTimerRef.current);
    toolFlashTimerRef.current = setTimeout(() => {
      toolFlashTimerRef.current = null;
      setToolDetailFlash(false);
    }, TOOL_DETAIL_FLASH_MS);
  }, []);
  // Timer do flash não sobrevive ao unmount do REPL.
  useEffect(
    () => () => {
      if (toolFlashTimerRef.current) clearTimeout(toolFlashTimerRef.current);
    },
    [],
  );
  // Nome do usuário pro "Welcome back <name>" — lido uma vez no boot.
  const [userName] = useState<string | undefined>(() => new UserRepository().get()?.name);
  // Avisos de setup (canal, pasta do workspace) — checagem barata, uma vez no
  // boot; o Welcome mostra em amarelo dim embaixo das dicas quando não vazio.
  const [setupIssues] = useState<string[]>(() =>
    boot.ok ? collectSetupIssues(boot.workspaceId) : [],
  );

  // Ref do streaming pra o handler de evento (closure estável) sempre ver o
  // atual. NUNCA escrito no corpo do render — só no listener do bus, no handler
  // de cancelamento e em `cancelActiveRun` (troca/reset de sessão de fato), os
  // únicos pontos que mudam o stream.
  const streamingRef = useRef<StreamingState | null>(null);
  // RunId cujo cancelamento já foi pedido — `cancelRun` vai UMA vez por run;
  // Esc repetido durante a janela do SIGTERM vira no-op (nada de nota duplicada).
  const cancellingRef = useRef<string | null>(null);

  const pushTurn = useCallback((turn: HistoryTurn) => {
    setHistory((h) => [...h, turn]);
  }, []);

  // Zera o transcript (conversa nova / clear / troca de agente ou workspace).
  // Além de esvaziar o history, avança a época pro `<Static>` remontar — o que
  // já foi impresso fica no scrollback do terminal (não dá pra "desimprimir"),
  // e o banner de boas-vindas reabre marcando o começo da conversa nova.
  // `/resume` passa os turns da sessão retomada pra semear o transcript novo.
  const resetTranscript = useCallback((turns: HistoryTurn[] = []) => {
    setHistory(turns);
    setTranscriptEpoch((n) => n + 1);
  }, []);

  // Atalho pros turns de um bloco só (user/note) — evita montar blocks na mão
  // em cada chamada.
  const pushText = useCallback(
    (role: HistoryTurn['role'], text: string) => {
      pushTurn({ role, blocks: [{ kind: 'text', text }] });
    },
    [pushTurn],
  );

  // Timer trailing do throttle de deltas: text/thinking-delta só mutam o
  // acumulador e ARMAM um flush (~50ms); eventos estruturais (tool, fase, fim,
  // erro) flusham na hora. Sem isso, cada delta virava um re-render inteiro.
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pedidos de aprovação que chegaram COM um overlay de aprovação já aberto —
  // esperam aqui (FIFO) e entram um a um conforme o operador decide. Ref (não
  // state): a fila só importa no momento da decisão, nunca dispara render.
  const approvalQueueRef = useRef<ApprovalRequest[]>([]);

  // Espelho do id do pedido de aprovação em foco no overlay (null = nenhum).
  // Handlers persistentes do bus (fim do run, expiração) rodam fora do render
  // e precisam saber se há aprovação aberta sem reregistrar listener a cada
  // mudança de overlay. Sincronizado num effect — nunca escrito no render.
  const openApprovalIdRef = useRef<string | null>(null);
  useEffect(() => {
    openApprovalIdRef.current = overlay?.kind === 'approval' ? overlay.req.id : null;
  }, [overlay]);

  // UM listener persistente do bus por sessão. Ele NÃO depende de termos chamado
  // `sendMessage` diretamente: ancora no `message-start` (que carrega sessionId),
  // então pega TANTO o run direto QUANTO o run que o serviço despacha sozinho da
  // fila ao terminar o anterior. Eventos sintéticos (mirror de issue) não travam
  // o composer e são ignorados aqui.
  useEffect(() => {
    if (!sessionId) return undefined;
    // Publica o snapshot atual do acumulador no state (referências novas →
    // re-render) e desarma qualquer flush pendente.
    const flushNow = (): void => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      const live = streamingRef.current;
      if (!live) return;
      const next: StreamingState = {
        ...live,
        blocks: live.acc.blocks(),
        phase: live.acc.phase(),
      };
      streamingRef.current = next;
      setStreaming(next);
    };
    // Arma um flush trailing se ainda não houver um — deltas em rajada colapsam
    // num único re-render a cada ~DELTA_FLUSH_MS.
    const scheduleFlush = (): void => {
      if (flushTimerRef.current) return;
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        flushNow();
      }, DELTA_FLUSH_MS);
    };
    const onEvent = (e: ChatStreamEvent): void => {
      // Início de um run NOVO da nossa sessão → abre um stream vivo se não houver.
      if (e.type === 'message-start') {
        if (e.synthetic || e.sessionId !== sessionId) return;
        const prev = streamingRef.current;
        if (prev) {
          // Já tem stream vivo. Se ele está SAUDÁVEL (não fechado e com evento
          // recente), ignora — o serviço não roda dois runs em paralelo. Mas um
          // acumulador já `done()` ou parado há STALE_RUN_MS é um run ÓRFÃO
          // (âncora perdida): fecha ele como turn e ADOTA o run novo, senão o
          // REPL ficaria surdo pra sempre.
          const orphaned = prev.acc.done() || Date.now() - prev.lastEventAt > STALE_RUN_MS;
          if (!orphaned) return;
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          const staleBlocks = prev.acc.blocks();
          const hasContent = staleBlocks.some(
            (b) => b.kind === 'tool' || (b.kind === 'text' && b.text.trim().length > 0),
          );
          if (hasContent) pushTurn({ role: 'assistant', blocks: staleBlocks });
          pushTurn({ role: 'note', blocks: [{ kind: 'text', text: 'run anterior encerrado.' }] });
          if (cancellingRef.current === prev.runId) cancellingRef.current = null;
        }
        const acc = new StreamAccumulator();
        const live: StreamingState = {
          acc,
          runId: e.runId,
          messageId: e.messageId,
          blocks: acc.blocks(),
          phase: acc.phase(),
          lastEventAt: Date.now(),
        };
        streamingRef.current = live;
        setStreaming(live);
        return;
      }
      const live = streamingRef.current;
      if (!live) return;
      // Filtra ao run/mensagem do stream vivo — o bus é global (canais, sintéticos…).
      if ('runId' in e && e.runId !== live.runId) return;
      if ('messageId' in e && e.messageId !== live.messageId) return;
      live.lastEventAt = Date.now();
      live.acc.apply(e);
      // Deltas de texto/thinking: só agendam o flush (nunca fecham o run — done
      // só vira em error/message-end, que caem no caminho imediato abaixo).
      if (e.type === 'text-delta' || e.type === 'thinking-delta') {
        scheduleFlush();
        return;
      }
      flushNow();
      if (live.acc.done()) {
        // `blocks()` aqui já é o CANÔNICO quando o `message-final` chegou antes
        // do `message-end` (o acumulador substitui o texto pelo persistido no
        // DB e vira o status das tools) — o turn fechado reflete o DB.
        const streamError = live.acc.error();
        const blocks = live.acc.blocks();
        if (streamError) {
          // O run falhou: mantém as tools que rodaram + o erro no lugar do texto.
          pushTurn({
            role: 'assistant',
            blocks: [
              ...blocks.filter((b) => b.kind === 'tool'),
              { kind: 'text', text: `erro: ${streamError}` },
            ],
          });
        } else {
          const hasContent = blocks.some(
            (b) => b.kind === 'tool' || (b.kind === 'text' && b.text.trim().length > 0),
          );
          pushTurn({
            role: 'assistant',
            blocks: hasContent ? blocks : [{ kind: 'text', text: '(sem resposta)' }],
          });
        }
        streamingRef.current = null;
        setStreaming(null);
        // Run fechou (done/erro/cancelado) — libera o guard de cancelamento.
        cancellingRef.current = null;
        // Aprovações pendentes morrem com o run que as pediu: o claude que
        // perguntou já fechou, decidir agora não teria efeito. Esvazia a fila
        // (o timeout do módulo nega cada pedido sozinho) e derruba o overlay
        // aberto — com nota dim só quando havia um em foco.
        approvalQueueRef.current = [];
        if (openApprovalIdRef.current !== null) {
          openApprovalIdRef.current = null;
          pushText('note', 'aprovação descartada — o run terminou.');
          setOverlay(null);
        }
        // ctx% do footer: tokensIn do run que acabou (input + cache), que o
        // serviço persiste ANTES de emitir o message-end — leitura pontual por
        // PK, uma vez por run. Run sem usage (cancelado cedo) mantém o valor
        // anterior em vez de apagar o indicador.
        const run = new AgentRunRepository().get(live.runId);
        if (run?.tokensIn) setCtxTokens(run.tokensIn);
      }
    };
    chatStreamBus.on('event', onEvent);
    return () => {
      chatStreamBus.off('event', onEvent);
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      streamingRef.current = null;
      setStreaming(null);
    };
  }, [sessionId, pushTurn, pushText]);

  // Aprovações de permissão (runs do REPL em modo `default`): o claude spawnado
  // chama a tool MCP `approval_prompt`, que emite 'request' no approvalBus — e o
  // overlay y/n aparece aqui. Só pedidos da NOSSA sessão (ou sem sessão
  // identificada) entram; um por vez, os demais aguardam na fila acima. O pedido
  // nega sozinho em 60s no módulo de aprovações, então é urgente: toma o lugar
  // de qualquer overlay informativo aberto (picker pode ser reaberto depois).
  useEffect(() => {
    if (!sessionId) return undefined;
    const onRequest = (req: ApprovalRequest): void => {
      if (req.sessionId !== null && req.sessionId !== sessionId) return;
      setOverlay((current) => {
        if (current?.kind === 'approval') {
          approvalQueueRef.current.push(req);
          return current;
        }
        return { kind: 'approval', req };
      });
    };
    // Pedido negado por timeout no módulo: some da fila local e, se era o que
    // estava em foco, derruba o overlay com nota dim — responder um prompt
    // morto seria no-op (resolveApproval devolveria false).
    const onExpired = (id: string): void => {
      approvalQueueRef.current = approvalQueueRef.current.filter((q) => q.id !== id);
      if (openApprovalIdRef.current !== id) return;
      openApprovalIdRef.current = null;
      pushText('note', 'aprovação expirou (negada)');
      const next = approvalQueueRef.current.shift();
      setOverlay(next ? { kind: 'approval', req: next } : null);
    };
    approvalBus.on('request', onRequest);
    approvalBus.on('expired', onExpired);
    return () => {
      approvalBus.off('request', onRequest);
      approvalBus.off('expired', onExpired);
      // Pedidos ainda na fila não têm mais aprovador nesta sessão — o timeout
      // do módulo os nega sozinho; só esvaziamos a fila local.
      approvalQueueRef.current = [];
    };
  }, [sessionId, pushText]);

  // Decide o pedido em foco (y = permite, n/Esc = nega), registra uma nota no
  // transcript e puxa o próximo da fila (ou fecha o overlay).
  const decideApproval = useCallback(
    (req: ApprovalRequest, allow: boolean) => {
      // `false` = o pedido já tinha expirado (negado por timeout) — a resposta
      // chegou tarde e não teve efeito; a nota não pode fingir que valeu.
      const settled = resolveApproval(req.id, allow);
      pushText(
        'note',
        settled
          ? `${allow ? 'permitido' : 'negado'} — ${req.toolName || 'tool'}`
          : 'aprovação já expirou',
      );
      const next = approvalQueueRef.current.shift();
      setOverlay(next ? { kind: 'approval', req: next } : null);
    },
    [pushText],
  );

  // Envia uma mensagem do usuário. `enqueueChatMessage` decide no serviço: sessão
  // ociosa → despacha na hora (o listener acima pega o `message-start`); run ATIVO
  // → enfileira e despacha sozinho quando o run atual fecha ("na fila"). O bubble
  // do usuário é plantado aqui, na hora do submit.
  const sendOrEnqueue = useCallback(
    async (content: string) => {
      pushText('user', content);
      try {
        const { enqueued } = await enqueueChatMessage({ sessionId, content, origin: 'cli' });
        if (enqueued) {
          pushText('note', 'na fila — vai assim que o run atual terminar.');
        }
      } catch (err) {
        pushText('note', `erro ao enviar: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [pushText, sessionId],
  );

  const openAgentOverlay = useCallback(() => {
    const items: SelectItem[] = listAgents(workspaceId).map((a) => ({
      id: a.id,
      label: a.name,
      meta: `${a.adapterType ?? 'sem adapter'} · ${a.model ?? 'default'}`,
      current: a.id === agentId,
    }));
    setOverlay({ kind: 'agent', items });
  }, [workspaceId, agentId]);

  const openWorkspaceOverlay = useCallback(() => {
    const items: SelectItem[] = [
      ...new WorkspaceRepository().listAll().map((w) => ({
        id: w.id,
        label: w.name,
        current: w.id === workspaceId,
      })),
      { id: WORKSPACE_CREATE_ID, label: '+ criar novo workspace' },
    ];
    setOverlay({ kind: 'workspace', items });
  }, [workspaceId]);

  // Cancela o run ativo (se houver) soltando o stream local na hora. Só é
  // chamado nos pontos que TROCAM/RESETAM a sessão DE FATO — nunca na abertura
  // de um overlay (Esc/escolher o atual não pode matar o run à toa). Retorna
  // true quando havia run e ele foi cancelado (pro chamador plantar a nota
  // DEPOIS do reset de transcript, senão ela some).
  const cancelActiveRun = useCallback((): boolean => {
    const live = streamingRef.current;
    if (!live) return false;
    cancelRun(live.runId, { pause: true });
    cancellingRef.current = live.runId;
    streamingRef.current = null;
    setStreaming(null);
    return true;
  }, []);

  // Troca a sessão do REPL pro workspace informado (persiste como ativo + resolve
  // o agente orquestrador/primeiro). Reúso entre o pick de workspace existente e
  // a criação de um novo. Retorna false (com aviso) se o workspace não tem agente.
  const switchToWorkspace = useCallback(
    (targetWorkspaceId: string): boolean => {
      new SettingsRepository().setDaemonActiveWorkspaceId(targetWorkspaceId);
      const nextAgent = listAgents(targetWorkspaceId)[0];
      if (!nextAgent) {
        pushText('note', 'esse workspace não tem agente — rode `orkestral init`.');
        return false;
      }
      // Troca DE FATO acontecendo: agora sim o run ativo é cancelado (não na
      // abertura do overlay — Esc/escolher o atual não chega aqui).
      const cancelledActiveRun = cancelActiveRun();
      setWorkspaceId(targetWorkspaceId);
      setAgentId(nextAgent.id);
      refreshAgent(nextAgent.id);
      const session = newSession({ workspaceId: targetWorkspaceId, agentId: nextAgent.id });
      setSessionId(session.id);
      setCtxTokens(null); // sessão nova = contexto zerado; ctx% some até o 1º run
      resetTranscript();
      if (cancelledActiveRun) pushText('note', 'run ativo cancelado.');
      return true;
    },
    [cancelActiveRun, pushText, refreshAgent, resetTranscript],
  );

  const openModelOverlay = useCallback(async () => {
    if (!agent?.adapterType) {
      pushText('note', 'agente sem adapter configurado — nada pra listar.');
      return;
    }
    try {
      const models = await getAdapter(agent.adapterType).listModels();
      const current = agent.model ?? 'default';
      const items: SelectItem[] = models.map((m) => ({
        id: m.id,
        label: m.label,
        meta: m.description,
        current: m.id === current,
      }));
      setOverlay({ kind: 'model', items });
    } catch (err) {
      pushText(
        'note',
        `não consegui listar modelos: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [agent, pushText]);

  const openPermissionsOverlay = useCallback(() => {
    const current = getPermissionMode();
    const items: SelectItem[] = PERMISSION_MODES.map((p) => ({
      id: p.mode,
      label: p.label,
      current: p.mode === current,
    }));
    setOverlay({ kind: 'permissions', items });
  }, []);

  // Aplica um modo de permissão escolhido no REPL: estado de processo (spawn
  // policy) + persistência na chave `daemon` (o próximo boot do REPL/serve
  // carrega — flags da CLI vencem) + snapshot local pro footer refletir na hora.
  const applyPermissionMode = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode);
    new SettingsRepository().setDaemonPermissionMode(mode);
    setPermMode(mode);
  }, []);

  // Shift+Tab: cicla o modo de permissão na ordem do PERMISSION_MODES (default
  // → acceptEdits → plan → dangerously-skip → volta). Além da nota no
  // transcript, o StatusLine reflete na hora — `permMode` é state e o set
  // re-renderiza o footer.
  const cyclePermissionMode = useCallback(() => {
    const order = PERMISSION_MODES.map((p) => p.mode);
    const next = order[(order.indexOf(getPermissionMode()) + 1) % order.length];
    applyPermissionMode(next);
    pushText('note', `permissão: ${next}${claudeOnlyHint(next)}`);
  }, [applyPermissionMode, pushText]);

  const openConfigOverlay = useCallback(() => {
    const configs = listEditableConfigs(workspaceId, agentId);
    const items: SelectItem[] = configs.map((c) => ({
      id: c.key,
      label: c.label,
      meta: c.get(),
    }));
    setOverlay({ kind: 'config', items, configs });
  }, [workspaceId, agentId]);

  const runCommand = useCallback(
    (name: string, args: string) => {
      // Comandos que TROCAM/RESETAM a sessão durante um run ativo cancelam o
      // run ANTES de rodar — senão o listener é derrubado (sessão nova) e o run
      // vira órfão queimando tokens; `/clear` ainda apagaria mensagens embaixo
      // de um run ativo. O stream local é solto na hora: o transcript vai ser
      // resetado/trocado, então o `message-end` do cancel não deve ressuscitar
      // o turn parcial depois. `/compact` não cancela — só espera. `/agent` e
      // `/workspace` NÃO cancelam aqui (isso é só a ABERTURA do overlay): o
      // cancel deles mora no momento da troca de fato (onPick/switchToWorkspace)
      // — Esc ou escolher o atual deixam o run vivo.
      if (streamingRef.current && name === 'compact') {
        pushText('note', 'run em andamento — aguarde o run terminar pra compactar.');
        return;
      }
      let cancelledActiveRun = false;
      if (name === 'new' || name === 'clear') {
        cancelledActiveRun = cancelActiveRun();
      }
      switch (name) {
        case 'new': {
          const session = newSession({ workspaceId, agentId });
          setSessionId(session.id);
          setCtxTokens(null); // conversa nova = contexto zerado; ctx% some até o 1º run
          resetTranscript();
          break;
        }
        case 'clear': {
          clearSession(sessionId);
          resetTranscript();
          // Mesmo sessionId, mas as mensagens foram apagadas — o contexto do
          // próximo run recomeça do zero; o ctx% antigo mentiria.
          setCtxTokens(null);
          break;
        }
        case 'compact': {
          void (async () => {
            try {
              const res = await compactSession({ sessionId, workspaceId });
              // Compactou de fato: o contexto do próximo run recomeça do
              // resumo — o ctx% da conversa cheia mentiria até o run seguinte.
              if (res?.created) setCtxTokens(null);
              pushText(
                'note',
                res?.created
                  ? `contexto compactado (${res.snapshot.messageCount} mensagens resumidas).`
                  : 'nada pra compactar ainda.',
              );
            } catch (err) {
              pushText(
                'note',
                `falha ao compactar: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          })();
          break;
        }
        case 'help':
          // Nota no transcript (não modal): fica no scrollback como referência.
          pushText('note', buildHelpText());
          break;
        case 'status': {
          // Snapshot do collectStatus com o agente/modelo REAIS do REPL (o
          // collectStatus sozinho chuta o orquestrador do workspace — aqui o
          // usuário pode ter trocado via /agent).
          const snapshot = collectStatus(workspaceId);
          const withReplAgent = agent
            ? {
                ...snapshot,
                agent: {
                  name: agent.name,
                  adapter: agent.adapterType ?? 'unknown',
                  model: agent.model ?? null,
                },
              }
            : snapshot;
          pushText('note', formatStatusText(withReplAgent, getPermissionMode()));
          break;
        }
        case 'agent':
          openAgentOverlay();
          break;
        case 'resume':
          // Só ABRE o picker — como /agent e /workspace, não cancela o run
          // aqui; o cancel mora no momento da troca de fato (onPick).
          setOverlay({ kind: 'resume', items: buildResumeItems(workspaceId, sessionId) });
          break;
        case 'workspace':
          openWorkspaceOverlay();
          break;
        case 'model': {
          // `/model <name>` seta direto; `/model` sozinho abre o seletor.
          const target = args.trim();
          if (target) {
            if (!agentId) break;
            new AgentRepository().update(agentId, { model: target });
            refreshAgent(agentId);
            pushText('note', `modelo do agente agora é "${target}".`);
          } else {
            void openModelOverlay();
          }
          break;
        }
        case 'permissions':
          openPermissionsOverlay();
          break;
        case 'config':
          openConfigOverlay();
          break;
        case 'channels':
          setOverlay({ kind: 'channels' });
          break;
        case 'cost':
          // Agregado direto do SQLite (SUM/COUNT numa query) — leitura barata,
          // roda só quando o usuário pede.
          pushText('note', buildCostText(new AgentRunRepository().sumUsageBySession(sessionId)));
          break;
        case 'exit':
          exit();
          break;
        default:
          break;
      }
      // Nota DEPOIS do comando: /new e /clear resetam o transcript — plantada
      // antes, a nota seria engolida pelo reset e nunca renderizaria.
      if (cancelledActiveRun) pushText('note', 'run ativo cancelado.');
    },
    [
      workspaceId,
      agentId,
      agent,
      sessionId,
      pushText,
      refreshAgent,
      resetTranscript,
      cancelActiveRun,
      openAgentOverlay,
      openWorkspaceOverlay,
      openModelOverlay,
      openPermissionsOverlay,
      openConfigOverlay,
      exit,
    ],
  );

  const onPick = useCallback(
    (pickedId: string) => {
      const current = overlay;
      setOverlay(null);
      if (!current) return;
      switch (current.kind) {
        case 'agent': {
          // Troca o agente abrindo uma sessão NOVA com ele (mais simples e correto:
          // a sessão é dona de UM agentId; reescrever a FK no meio da conversa
          // misturaria histórico de dois agentes). Conversa nova = histórico limpo.
          if (pickedId === agentId) break;
          // Troca DE FATO: só aqui o run ativo é cancelado (Esc no overlay ou
          // escolher o agente atual saem antes e deixam o run vivo).
          const cancelledActiveRun = cancelActiveRun();
          setAgentId(pickedId);
          refreshAgent(pickedId);
          const session = newSession({ workspaceId, agentId: pickedId });
          setSessionId(session.id);
          setCtxTokens(null); // sessão nova = contexto zerado; ctx% some até o 1º run
          resetTranscript();
          if (cancelledActiveRun) pushText('note', 'run ativo cancelado.');
          break;
        }
        case 'workspace': {
          // "+ criar novo workspace" → abre o fluxo de criação (não troca ainda).
          if (pickedId === WORKSPACE_CREATE_ID) {
            setOverlay({ kind: 'workspace-create' });
            break;
          }
          if (pickedId === workspaceId) break;
          switchToWorkspace(pickedId);
          break;
        }
        case 'resume': {
          // Escolher a sessão ATUAL é no-op (Esc já fecharia igual).
          if (pickedId === sessionId) break;
          const session = new ChatSessionRepository().get(pickedId);
          if (!session) {
            pushText('note', 'sessão não encontrada — pode ter sido apagada.');
            break;
          }
          // Troca DE FATO: cancela o run ativo (mesma regra do /agent) e o
          // listener do bus re-ancora sozinho quando o sessionId muda.
          const cancelledActiveRun = cancelActiveRun();
          // A sessão é dona de UM agentId — retomar uma conversa de outro
          // agente troca o agente do REPL junto (footer coerente).
          if (session.agentId !== agentId) {
            setAgentId(session.agentId);
            refreshAgent(session.agentId);
          }
          setSessionId(session.id);
          setCtxTokens(null); // contexto da sessão retomada só é conhecido no próximo run
          // Hidrata o transcript pelo MESMO caminho do boot (mensagens → turns).
          resetTranscript(messagesToTurns(new MessageRepository().listBySession(session.id)));
          pushText('note', 'sessão retomada — /new começa uma conversa nova.');
          if (cancelledActiveRun) pushText('note', 'run ativo cancelado.');
          break;
        }
        case 'model': {
          if (!agentId) break;
          new AgentRepository().update(agentId, { model: pickedId });
          refreshAgent(agentId);
          pushText('note', `modelo do agente agora é "${pickedId}".`);
          break;
        }
        case 'permissions': {
          const mode = pickedId as PermissionMode;
          applyPermissionMode(mode);
          pushText('note', `modo de permissão: ${mode}${claudeOnlyHint(mode)}.`);
          break;
        }
        case 'config': {
          // Etapa 1 → etapa 2: escolheu QUAL config; abre o seletor de valores
          // dela (marcando o valor atual). Não fecha o overlay — encadeia.
          const config = current.configs.find((c) => c.key === pickedId);
          if (!config) break;
          const value = config.get();
          const items: SelectItem[] = config.options.map((opt) => ({
            id: opt,
            label: opt,
            current: opt === value,
          }));
          setOverlay({ kind: 'config-value', items, config });
          break;
        }
        case 'config-value': {
          // Etapa 2: persiste o valor escolhido pelo setter REAL da config.
          current.config.set(pickedId);
          // Permission mode também vive no footer — refresca o snapshot local.
          if (current.config.key === 'permissionMode') {
            setPermMode(getPermissionMode());
          }
          // Autonomia mexe no agente ativo — relê pro footer/estado ficar coerente.
          if (current.config.key === 'agentAutonomy' && agentId) {
            refreshAgent(agentId);
          }
          pushText('note', `salvo · ${current.config.label}: ${pickedId}`);
          break;
        }
        default:
          break;
      }
    },
    [
      overlay,
      agentId,
      workspaceId,
      sessionId,
      pushText,
      refreshAgent,
      switchToWorkspace,
      resetTranscript,
      cancelActiveRun,
      applyPermissionMode,
    ],
  );

  const submit = useCallback(
    (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      // Guarda a linha enviada no histórico de ↑/↓ (dedupe consecutivo + cap) e
      // persiste no arquivo — o ↑ recupera na próxima sessão também.
      sentHistoryRef.current = pushLine(sentHistoryRef.current, trimmed, HISTORY_CAP);
      appendHistory(trimmed);
      histNavRef.current = null;
      const parsed = parseInput(trimmed);
      if (parsed.kind === 'message') {
        void sendOrEnqueue(parsed.text);
      } else if (parsed.kind === 'command') {
        runCommand(parsed.name, parsed.args);
      } else {
        pushText('note', `comando desconhecido "/${parsed.name}" — /help`);
      }
    },
    [sendOrEnqueue, runCommand, pushText],
  );

  // Autocomplete de slash commands: ativo quando o input começa com `/` e ainda
  // está digitando o NOME do comando (sem espaço — depois do espaço é arg). A
  // query é o texto entre `/` e o primeiro espaço. Some quando fechado por Esc.
  const acQuery = useMemo(() => {
    // No meio de uma mensagem multi-linha, `/` é CONTEÚDO (a linha vai ser
    // juntada às pendentes), não comando — popup fica fora.
    if (pendingLines.length > 0) return null;
    if (!input.startsWith('/')) return null;
    if (input.includes(' ')) return null; // já está nos args → sem popup
    return input.slice(1);
  }, [input, pendingLines]);
  const acMatches = useMemo(() => (acQuery === null ? [] : filterCommands(acQuery)), [acQuery]);
  const acActive = acQuery !== null && !acClosed && acMatches.length > 0;

  // Autocomplete de `@arquivo`: ativo quando o cursor está num token `@…` (do
  // último whitespace até o cursor). Precedência: linha de slash command (`/…`
  // sem pendentes) é DONA do input — mention não se aplica em comando, então o
  // token nem é detectado lá; com pendentes, `/` é conteúdo e a mention vale.
  const fileAcToken = useMemo(() => {
    if (pendingLines.length === 0 && input.startsWith('/')) return null;
    return activeMentionToken(input, cursor);
  }, [input, cursor, pendingLines]);
  // Lista de arquivos carregada LAZY no primeiro `@` — `loadWorkspaceFiles` tem
  // cache de 60s por workspace no módulo, então re-render/tecla seguinte não
  // re-varre o disco.
  const fileAcMatches = useMemo(
    () =>
      fileAcToken === null ? [] : filterFiles(loadWorkspaceFiles(workspaceId), fileAcToken.query),
    [fileAcToken, workspaceId],
  );
  const fileAcActive = fileAcToken !== null && !acClosed && fileAcMatches.length > 0;
  // Índice clampado: mover o CURSOR muda a query sem resetar o acIndex (só
  // mudança de texto reseta) — a seleção nunca aponta fora da lista.
  const fileAcIndex = Math.min(acIndex, fileAcMatches.length - 1);

  // Completa o input pro comando destacado (`/<name> `), pronto pra digitar args.
  const completeWith = useCallback((name: string) => {
    const next = `/${name} `;
    setInput(next);
    setCursor(next.length);
    setAcClosed(true);
    setAcIndex(0);
  }, []);

  // Aceita a mention destacada: substitui o token `@…` (do início dele até o
  // cursor) por `@relPath ` e deixa o cursor no fim da inserção — o texto DEPOIS
  // do cursor fica intacto. A mention vai LITERAL na mensagem (paridade com a
  // GUI: sem expansão no servidor; o modelo resolve o path relativo porque o
  // cwd do spawn é a raiz da source).
  const completeFileWith = useCallback(
    (relPath: string) => {
      if (!fileAcToken) return;
      const inserted = `@${relPath} `;
      setInput(input.slice(0, fileAcToken.start) + inserted + input.slice(cursor));
      setCursor(fileAcToken.start + inserted.length);
      setAcClosed(true);
      setAcIndex(0);
    },
    [fileAcToken, input, cursor],
  );

  // Navega o histórico de mensagens enviadas com ↑/↓ (só quando o popup de
  // autocomplete NÃO está ativo e não está streamando). ↑ recua pro mais antigo,
  // ↓ avança pro mais novo e, no fim, volta pro input vazio. O índice fica num
  // ref pra sobreviver entre toques sem re-render extra.
  const recallHistory = useCallback((dir: 'prev' | 'next') => {
    const hist = sentHistoryRef.current;
    if (hist.length === 0) return;
    const cur = histNavRef.current;
    if (dir === 'prev') {
      // null (input livre) → último item; senão recua, parando no índice 0.
      const nextIdx = cur === null ? hist.length - 1 : Math.max(0, cur - 1);
      histNavRef.current = nextIdx;
      setInput(hist[nextIdx]);
      setCursor(hist[nextIdx].length); // recall deixa o cursor no fim
    } else {
      // ↓ só faz algo se já estamos navegando. Passou do mais novo → input vazio.
      if (cur === null) return;
      const nextIdx = cur + 1;
      if (nextIdx >= hist.length) {
        histNavRef.current = null;
        setInput('');
        setCursor(0);
      } else {
        histNavRef.current = nextIdx;
        setInput(hist[nextIdx]);
        setCursor(hist[nextIdx].length);
      }
    }
    // Mudança de input veio da NAVEGAÇÃO — mantém o popup de autocomplete
    // FECHADO mesmo quando a linha recuperada começa com `/` (senão o próximo ↑
    // navegaria o popup em vez do histórico). Digitar um char reabre (o caminho
    // de edição faz `setAcClosed(false)` quando o texto muda).
    setAcClosed(true);
    setAcIndex(0);
  }, []);

  // Input de texto: ativo quando NÃO há overlay aberto. CONTINUA ativo durante o
  // stream — assim o usuário digita um follow-up que vai pra FILA (o serviço
  // despacha quando o run atual fecha). O Selector tem seu próprio useInput.
  const inputActive = !needsSetup && !overlay;
  useInput(
    (ch, key) => {
      // Shift+Tab cicla o modo de permissão — SEMPRE, com input vazio ou não,
      // e ANTES do Tab do autocomplete (que só aceita Tab sem shift).
      if (key.tab && key.shift) {
        cyclePermissionMode();
        return;
      }
      // Ctrl+L limpa o transcript VISUAL (remonta o <Static> via época e
      // reimprime o Welcome) — a sessão fica intacta: histórico/mensagens
      // continuam no DB, nada de clearSession aqui.
      if (key.ctrl && ch === 'l') {
        resetTranscript();
        return;
      }
      // Ctrl+O cicla o detalhe das tools (off → preview): muda o stream vivo e
      // os turns impressos DEPOIS do toggle (o <Static> não reimprime antigos).
      if (key.ctrl && ch === 'o') {
        cycleToolDetail();
        return;
      }
      // Navegação/aceite/fechamento do popup de autocomplete têm prioridade
      // sobre o handling normal de texto enquanto ele está visível.
      if (acActive) {
        if (key.upArrow) {
          setAcIndex((i) => (i - 1 + acMatches.length) % acMatches.length);
          return;
        }
        if (key.downArrow) {
          setAcIndex((i) => (i + 1) % acMatches.length);
          return;
        }
        if (key.tab && !key.shift) {
          completeWith(acMatches[acIndex].name);
          return;
        }
        if (key.escape) {
          // Esc fecha SÓ o popup (antes de qualquer outro comportamento de Esc).
          setAcClosed(true);
          return;
        }
        if (key.return) {
          // Enter aceita E executa o destacado num toque só: monta `/<name>` e
          // despacha pelo mesmo caminho do submit normal (overlay pra
          // model/agent/etc; ação imediata pra new/clear/help/exit). Tab continua
          // sendo o "completar sem executar" (`/<name> ` pra digitar args).
          setInput('');
          setCursor(0);
          setAcClosed(false);
          setAcIndex(0);
          submit(`/${acMatches[acIndex].name}`);
          return;
        }
      }
      // Popup de `@arquivo` — mutuamente exclusivo com o de slash (a detecção
      // do token já cede a linha de comando). Tab E Enter fazem o MESMO aqui:
      // inserem `@relPath ` no lugar do token (Enter não submete — aceitar a
      // mention e enviar são dois gestos).
      if (fileAcActive) {
        if (key.upArrow) {
          setAcIndex((fileAcIndex - 1 + fileAcMatches.length) % fileAcMatches.length);
          return;
        }
        if (key.downArrow) {
          setAcIndex((fileAcIndex + 1) % fileAcMatches.length);
          return;
        }
        if ((key.tab && !key.shift) || key.return) {
          completeFileWith(fileAcMatches[fileAcIndex].relPath);
          return;
        }
        if (key.escape) {
          // Esc fecha SÓ o popup (antes de qualquer outro comportamento de Esc).
          setAcClosed(true);
          return;
        }
      }
      // --- Popup NÃO ativo daqui pra baixo ---
      const isStreaming = streamingRef.current !== null;

      // ↑/↓ recuperam mensagens enviadas (só com input livre, sem streaming —
      // durante o stream o ↑/↓ não navega histórico pra não atropelar o follow-up
      // que o usuário possa estar digitando pra fila).
      if ((key.upArrow || key.downArrow) && !isStreaming) {
        escArmedAtRef.current = null; // qualquer não-Esc desarma o Esc-Esc
        recallHistory(key.upArrow ? 'prev' : 'next');
        return;
      }

      // Enter submete. Ctrl+C fica fora daqui (handler global).
      if (key.return) {
        // Continuação multi-linha: linha terminando em `\` NÃO submete — o `\`
        // sai, a linha vira pendente e o input limpa pra próxima linha.
        if (input.endsWith('\\')) {
          setPendingLines((p) => [...p, input.slice(0, -1)]);
          setInput('');
          setCursor(0);
          setAcClosed(false);
          setAcIndex(0);
          resetInputNavState();
          return;
        }
        // Sem `\` no fim: submete pendentes + linha atual juntas por \n (o
        // histórico de ↑/↓ guarda o texto completo — o submit persiste o join).
        const line = pendingLines.length > 0 ? [...pendingLines, input].join('\n') : input;
        setPendingLines([]);
        setInput('');
        setCursor(0);
        setAcClosed(false);
        setAcIndex(0);
        resetInputNavState();
        submit(line);
        return;
      }
      if (key.escape) {
        // Streaming: deixa o handler global cancelar o run (não limpa input aqui).
        if (isStreaming) {
          escArmedAtRef.current = null;
          return;
        }
        // Ocioso + sem popup: 1º Esc arma, 2º Esc (dentro da janela) limpa o
        // input E as linhas pendentes da multi-linha (descarta o rascunho todo).
        const now = Date.now();
        const armedAt = escArmedAtRef.current;
        if (armedAt !== null && now - armedAt <= ESC_ESC_WINDOW_MS) {
          escArmedAtRef.current = null;
          histNavRef.current = null;
          setPendingLines([]);
          setInput('');
          setCursor(0);
          setAcClosed(false);
          setAcIndex(0);
        } else {
          escArmedAtRef.current = now;
        }
        return;
      }
      // Edição de texto de verdade (insert/backspace/delete/setas/home/end/
      // ctrl+u/k/w/paste) — toda a lógica vive no helper puro. `handled: false`
      // = tecla que não nos diz respeito (ex.: Ctrl+C do handler global).
      const edited = applyKeyToBuffer(input, cursor, ch, key);
      if (!edited.handled) return;
      escArmedAtRef.current = null; // qualquer edição desarma o Esc-Esc
      if (edited.value !== input) {
        // Mudou o TEXTO (não só o cursor): reabre o popup fechado por Esc e sai
        // da navegação de histórico — mover o cursor não mexe nesses estados.
        setAcClosed(false);
        setAcIndex(0);
        histNavRef.current = null;
      }
      setInput(edited.value);
      setCursor(edited.cursor);
    },
    { isActive: inputActive },
  );

  // Handler GLOBAL de Ctrl+C/Esc — SEMPRE ativo (`exitOnCtrlC: false` no render,
  // então o Ink não sai sozinho; quem decide é aqui).
  //   - Streamando: CANCELA o run ativo (pause: não despacha a fila — Stop é
  //     intenção explícita de parar, não de seguir pra próxima).
  //   - Ocioso: Ctrl+C SAI (Esc ocioso não faz nada; overlays tratam seu Esc).
  useInput((_ch, key) => {
    // Esc fecha o popup de autocomplete (slash OU @arquivo) ANTES de qualquer
    // outro comportamento de Esc (cancelar run). O handler do input já marcou
    // acClosed; aqui só absorve o Esc pra não cancelar o run no mesmo toque.
    if (key.escape && (acActive || fileAcActive)) return;
    // QUALQUER overlay aberto é dono do próprio Esc (Selector/help fecham via
    // onCancel/onClose; canais e criação de workspace têm handler próprio) —
    // nunca deixa o Esc de um overlay vazar pro cancelamento de run.
    if (key.escape && overlay !== null) return;
    const live = streamingRef.current;
    if (live && (key.escape || (key.ctrl && _ch === 'c'))) {
      // Dedup por run: o SIGTERM leva um tempo pra fechar o run — Esc repetido
      // nessa janela é no-op (nada de `cancelRun` nem nota a cada toque). O run
      // finaliza normal no `message-end` (o texto parcial vira o turn).
      // EXCEÇÃO: um SEGUNDO Ctrl+C com o cancel em voo força a saída do REPL —
      // um run travado (que nunca emite `message-end`) não pode prender o
      // teclado do usuário pra sempre.
      if (cancellingRef.current === live.runId) {
        if (key.ctrl && _ch === 'c') exit();
        return;
      }
      cancellingRef.current = live.runId;
      cancelRun(live.runId, { pause: true });
      // Feedback imediato: o spinner vira "cancelando…" + UMA nota no transcript.
      const next: StreamingState = { ...live, cancelling: true };
      streamingRef.current = next;
      setStreaming(next);
      pushText('note', 'cancelando…');
      return;
    }
    if (!live && key.ctrl && _ch === 'c') exit();
  });

  // Itens do transcript estático: banner de boas-vindas + turns FECHADOS, em
  // ordem. O `<Static>` imprime cada item UMA vez e nunca mais re-renderiza —
  // só a área viva (stream atual + input + status) fica dinâmica. A lista é
  // append-only dentro de uma época (reset = remonta via key).
  const transcriptItems = useMemo<TranscriptItem[]>(
    () => [
      { id: 'welcome', kind: 'welcome' },
      ...history.map((turn, i): TranscriptItem => ({ id: `turn-${i}`, kind: 'turn', turn })),
    ],
    [history],
  );

  // Sem workspace/agente: abre o wizard de setup direto (em vez de tela morta
  // sem input). O useInput de texto (isActive: inputActive) já fica inativo com
  // needsSetup; o handler global de Ctrl+C segue ativo pra permitir sair.
  if (needsSetup) {
    return <InitWizard />;
  }

  return (
    <Box flexDirection="column">
      <Static key={transcriptEpoch} items={transcriptItems}>
        {(item) =>
          item.kind === 'welcome' ? (
            <Welcome
              key={item.id}
              name={userName}
              agentName={agent?.name}
              model={agent?.model ?? 'default'}
              cwd={process.cwd()}
              setupIssues={setupIssues}
            />
          ) : (
            <TurnView key={item.id} turn={item.turn} toolDetail={toolDetail} />
          )
        }
      </Static>

      {streaming && (
        <Box flexDirection="column" marginBottom={1}>
          <TurnBlocks blocks={streaming.blocks} toolDetail={toolDetail} />
          <RunSpinnerLine phase={streaming.phase} cancelling={!!streaming.cancelling} />
        </Box>
      )}

      {overlay?.kind === 'approval' ? (
        <ApprovalPrompt
          req={overlay.req}
          onDecide={(allow) => decideApproval(overlay.req, allow)}
        />
      ) : overlay?.kind === 'channels' ? (
        <ChannelConnect
          workspaceId={workspaceId}
          agentId={agentId}
          onDone={() => {
            setOverlay(null);
            pushText('note', 'canais — fechado.');
          }}
        />
      ) : overlay?.kind === 'workspace-create' ? (
        <WorkspaceCreate
          onCreated={(newWorkspaceId) => {
            setOverlay(null);
            if (switchToWorkspace(newWorkspaceId)) {
              pushText('note', 'workspace criado e ativado.');
            }
          }}
          onCancel={() => setOverlay(null)}
        />
      ) : overlay ? (
        <OverlayView overlay={overlay} onPick={onPick} onCancel={() => setOverlay(null)} />
      ) : (
        <Box flexDirection="column">
          {/* Bloco pendente da multi-linha: as linhas já "entradas" com `\`,
              dim e prefixadas com `…` — o Enter sem `\` envia tudo junto. */}
          {pendingLines.map((line, i) => (
            <Text key={i} dimColor>
              … {line}
            </Text>
          ))}
          <TextInput
            value={input}
            cursor={cursor}
            prompt="›"
            placeholder={
              // A dica de cancelar (esc) mora na RunSpinnerLine — sempre visível
              // durante o stream, mesmo com o input preenchido.
              streaming ? ' (Enter envia pra fila)' : ' (digite ou /comando)'
            }
          />
          {acActive && acQuery !== null ? (
            <CommandAutocomplete query={acQuery} selectedIndex={acIndex} />
          ) : fileAcActive ? (
            <FileAutocomplete matches={fileAcMatches} selectedIndex={fileAcIndex} />
          ) : null}
          <StatusLine
            agentName={agent?.name ?? '—'}
            model={agent?.model ?? 'default'}
            permMode={permMode}
            workspaceName={workspaceName}
            streaming={!!streaming}
            ctxTokens={ctxTokens}
            toolDetailNote={toolDetailFlash ? toolDetail : null}
          />
        </Box>
      )}
    </Box>
  );
}

/** Frames braille do spinner do run ao vivo. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Linha de status do run AO VIVO, embaixo do texto streamando: spinner animado
 * + fase atual (fallback "pensando…") + segundos decorridos + dica de abortar.
 * A dica de Esc fica SEMPRE visível enquanto streama (não depende do input
 * vazio como o placeholder). Só é montada durante o stream — o `useAnimation`
 * do Ink desinscreve o timer no unmount, então nada fica rodando após o run.
 */
function RunSpinnerLine({
  phase,
  cancelling,
}: {
  phase: string | null;
  /** Cancel pedido: a fase vira "cancelando…" e a dica de esc some (é no-op). */
  cancelling: boolean;
}): React.ReactElement {
  // `frame` avança a cada ~80ms; `time` = ms desde a montagem (= início do run,
  // já que o componente nasce no message-start). Um hook só cobre os dois.
  const { frame, time } = useAnimation({ interval: 80 });
  const elapsed = Math.floor(time / 1000);
  return (
    <Text>
      <Text color="#a78bfa">{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Text>{' '}
      {cancelling ? 'cancelando…' : (phase ?? 'pensando…')}
      <Text dimColor>
        {' '}
        · {elapsed}s{cancelling ? '' : ' · esc interrompe'}
      </Text>
    </Text>
  );
}

/** Um turn fechado do transcript: prefixo por role + blocos (assistant). */
function TurnView({
  turn,
  toolDetail,
}: {
  turn: HistoryTurn;
  toolDetail: ToolDetailMode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {turn.role === 'user' && <Text color="cyan">você › {turnText(turn)}</Text>}
      {turn.role === 'assistant' && <TurnBlocks blocks={turn.blocks} toolDetail={toolDetail} />}
      {turn.role === 'note' && <NoteView text={turnText(turn)} />}
    </Box>
  );
}

/**
 * Nota do transcript. Notas de uma linha continuam `· texto`; multi-linha
 * (/help, /status) ganham indent consistente nas continuações — sem isso a 2ª
 * linha em diante colava na coluna 0, desalinhada do bullet.
 */
function NoteView({ text }: { text: string }): React.ReactElement {
  const lines = text.split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} dimColor>
          {i === 0 ? '· ' : '  '}
          {line}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Blocos de um turn do assistant, na ordem do stream: texto corrido + linhas de
 * tool. Usado TANTO no stream vivo quanto nos turns fechados — as tools ficam
 * no transcript pra sempre. Blocos de texto vazios (só whitespace) são pulados.
 * O texto passa pelo renderer de markdown (negrito, código, bullets, fences) —
 * só o texto do ASSISTANT; turns de user/note renderizam cru no TurnView.
 */
function TurnBlocks({
  blocks,
  toolDetail,
}: {
  blocks: readonly StreamBlock[];
  toolDetail: ToolDetailMode;
}): React.ReactElement {
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === 'text' ? (
          block.text.trim() ? (
            <MarkdownText key={i}>{block.text}</MarkdownText>
          ) : null
        ) : (
          <ToolLine key={block.id} block={block} detail={toolDetail} />
        ),
      )}
    </>
  );
}

/**
 * `⏺ name(args)` — pending=amarelo, done=verde ✓, error=vermelho ✗. Com
 * `detail='preview'` e output conhecido, as primeiras linhas do output entram
 * dim e indentadas embaixo da linha da tool (+ `…` quando o output foi cortado).
 */
function ToolLine({
  block,
  detail,
}: {
  block: Extract<StreamBlock, { kind: 'tool' }>;
  detail: ToolDetailMode;
}): React.ReactElement {
  const color = block.status === 'error' ? 'red' : block.status === 'done' ? 'green' : 'yellow';
  const suffix = block.status === 'done' ? ' ✓' : block.status === 'error' ? ' ✗' : '';
  const previewLines =
    detail === 'preview' && block.outputPreview ? block.outputPreview.split('\n') : null;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color}>⏺</Text> {block.name}
        {block.argsSummary ? <Text dimColor>({block.argsSummary})</Text> : null}
        {suffix ? <Text color={color}>{suffix}</Text> : null}
      </Text>
      {previewLines
        ? previewLines.map((line, i) => (
            <Text key={i} dimColor>
              {'  '}
              {line}
            </Text>
          ))
        : null}
      {previewLines && block.outputTruncated ? <Text dimColor>{'  …'}</Text> : null}
    </Box>
  );
}

/** Corte do preview de args no overlay de aprovação (JSON numa linha, dim). */
const APPROVAL_PREVIEW_MAX = 200;

/**
 * Overlay de aprovação de permissão: "Permitir <tool>?" + preview dim dos args.
 * Decide por tecla — y/Y permite, n/N e Esc negam (o guard global de Esc do REPL
 * já impede o Esc de vazar pro cancelamento de run enquanto há overlay). Mostra
 * UM pedido; a fila de pedidos simultâneos vive no chamador (decideApproval).
 */
function ApprovalPrompt({
  req,
  onDecide,
}: {
  req: ApprovalRequest;
  onDecide: (allow: boolean) => void;
}): React.ReactElement {
  useInput((ch, key) => {
    if (ch === 'y' || ch === 'Y') {
      onDecide(true);
      return;
    }
    if (ch === 'n' || ch === 'N' || key.escape) onDecide(false);
  });
  // `input` veio do body JSON-RPC (sempre serializável) — preview numa linha.
  const preview = truncateLine(JSON.stringify(req.input), APPROVAL_PREVIEW_MAX);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text>
        Permitir{' '}
        <Text bold color="#a78bfa">
          {req.toolName || 'tool'}
        </Text>
        ?
      </Text>
      <Text dimColor>{preview}</Text>
      <Text dimColor>(y) permitir · (n) negar</Text>
    </Box>
  );
}

function OverlayView({
  overlay,
  onPick,
  onCancel,
}: {
  // `channels`/`workspace-create`/`approval` são renderizados direto no Repl
  // (componentes próprios, com input próprio), nunca aqui.
  overlay: Exclude<
    Overlay,
    { kind: 'channels' } | { kind: 'workspace-create' } | { kind: 'approval' }
  >;
  onPick: (id: string) => void;
  /** Esc no overlay — fecha sem escolher nada. */
  onCancel: () => void;
}): React.ReactElement {
  const title =
    overlay.kind === 'agent'
      ? 'Trocar agente (↑↓ + Enter)'
      : overlay.kind === 'workspace'
        ? 'Trocar workspace (↑↓ + Enter)'
        : overlay.kind === 'model'
          ? 'Trocar modelo (↑↓ + Enter)'
          : overlay.kind === 'permissions'
            ? 'Modo de permissão (↑↓ + Enter)'
            : overlay.kind === 'config'
              ? 'Configurações (↑↓ + Enter)'
              : overlay.kind === 'resume'
                ? 'Retomar conversa (↑↓ + Enter)'
                : `${overlay.config.label} (↑↓ + Enter)`;
  return <Selector title={title} items={overlay.items} onPick={onPick} onCancel={onCancel} />;
}

/**
 * Footer de status do REPL: `agente · modelo · permissão · cwd/workspace ·
 * ctx ~N%`. Agente e modelo na cor de marca (accent); o resto em muted.
 * `dangerously-skip` ganha cor de alerta (amarelo) pra deixar óbvio que o
 * full-auto está ligado. O ctx% (tokensIn do último run / janela de 200k) só
 * aparece depois do primeiro run e escala a cor: dim → amarelo (>70%) →
 * vermelho (>90%); acima de 99% trava em `99%+`.
 */
function StatusLine({
  agentName,
  model,
  permMode,
  workspaceName,
  streaming,
  ctxTokens,
  toolDetailNote,
}: {
  agentName: string;
  model: string;
  permMode: PermissionMode;
  workspaceName: string;
  streaming: boolean;
  /** tokensIn do último run fechado — null antes do primeiro run (omite ctx%). */
  ctxTokens: number | null;
  /** Flash transiente do Ctrl+O ("tools: preview") — null fora da janela. */
  toolDetailNote: ToolDetailMode | null;
}): React.ReactElement {
  const danger = permMode === 'dangerously-skip';
  const ctxPct =
    ctxTokens !== null ? Math.round((ctxTokens / CLAUDE_CONTEXT_WINDOW_TOKENS) * 100) : null;
  const ctxColor =
    ctxPct === null ? undefined : ctxPct > 90 ? 'red' : ctxPct > 70 ? 'yellow' : undefined;
  return (
    <Text>
      <Text color="#a78bfa" bold>
        {agentName}
      </Text>
      <Text dimColor> · </Text>
      <Text color="#a78bfa">{model}</Text>
      <Text dimColor> · </Text>
      <Text color={danger ? 'yellow' : undefined} dimColor={!danger} bold={danger}>
        {permMode}
      </Text>
      <Text dimColor>{claudeOnlyHint(permMode)}</Text>
      <Text dimColor> · {workspaceName}</Text>
      {ctxPct !== null ? (
        <>
          <Text dimColor> · </Text>
          <Text color={ctxColor} dimColor={!ctxColor}>
            ctx ~{ctxPct > 99 ? '99%+' : `${ctxPct}%`}
          </Text>
        </>
      ) : null}
      {toolDetailNote !== null ? <Text dimColor> · tools: {toolDetailNote}</Text> : null}
      {streaming ? <Text color="yellow"> · respondendo…</Text> : null}
    </Text>
  );
}
