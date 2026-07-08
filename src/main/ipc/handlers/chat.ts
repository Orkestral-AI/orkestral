import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { registerHandler } from '../register';
import { ORKESTRAL_WORKSPACES_DIR } from '../../db/connection';
import { AgentRepository } from '../../db/repositories/agent.repo';
import { ChatSessionRepository } from '../../db/repositories/session.repo';
import { MessageRepository } from '../../db/repositories/message.repo';
import {
  cancelRun,
  sendMessage,
  requestHiringTeamBlocks,
  enqueueChatMessage,
  listChatQueue,
  setChatQueueItemKind,
  cancelChatQueueItem,
} from '../../services/chat-service';
import { listAgentActivity, getAgentActivityStats } from '../../services/agent-activity-service';
import { cancelIssueExecutionByRunId } from '../../services/issue-execution-service';
import {
  ensureDefaultInstructions,
  listInstructions,
  readInstruction,
  writeInstruction,
  deleteInstruction,
} from '../../services/agent-instructions';
import { runHeartbeat, cancelHeartbeat } from '../../services/heartbeat-service';
import { HeartbeatRunRepository } from '../../db/repositories/heartbeat-run.repo';
import { AgentApiKeyRepository } from '../../db/repositories/agent-api-key.repo';
import {
  decideHiringApply,
  materializeApprovedHiringPlan,
  parseHiringPlanDecision,
  type ParsedHiringPlanDecision,
} from '../../services/agent-from-chat';
import { listSourceAgentAssignments } from '../../services/source-agent-assignment-service';
import { createSourceSpecialistAgent } from '../../services/source-specialist-agent-service';
import { ActivityRepository } from '../../db/repositories/activity.repo';
import { isForgeBundled } from '../../services/smart-exec/config';
import { mt } from '../../i18n';
import { createFirstAgent } from './onboarding';

const agentRepo = new AgentRepository();
const sessionRepo = new ChatSessionRepository();
const messageRepo = new MessageRepository();
const heartbeatRepo = new HeartbeatRunRepository();
const apiKeyRepo = new AgentApiKeyRepository();
const activityRepo = new ActivityRepository();

/**
 * Sessões com `hiring:apply-plan` EM VOO. O handler é async (pode `await`
 * requestHiringTeamBlocks, que leva segundos) — sem este lock, um 2º clique de
 * "Aprovar e criar" durante a espera dispara um 2º apply concorrente (re-pede
 * blocos ao CEO → a duplicata de "criar plano"). Pós-conclusão, o marcador
 * `proposal.applied` (getAppliedProposal) cobre os re-fires sequenciais.
 */
const applyingHiringSessions = new Set<string>();

export function registerChatHandlers(): void {
  // -------- Agentes --------
  registerHandler('agent:list', ({ workspaceId }) => agentRepo.listByWorkspace(workspaceId));
  registerHandler('agent:source-assignments', ({ workspaceId }) =>
    listSourceAgentAssignments(workspaceId),
  );
  registerHandler('agent:create-source-specialist', ({ workspaceId, sourceId }) =>
    createSourceSpecialistAgent({ workspaceId, sourceId }),
  );
  registerHandler('agent:get', ({ agentId }) => agentRepo.get(agentId));

  registerHandler('agent:create', (input) => {
    const agent = agentRepo.create({
      workspaceId: input.workspaceId,
      name: input.name,
      role: input.role,
      title: input.title,
      adapterType: input.adapterType,
      model: input.model,
      adapterConfig: input.adapterConfig,
      systemPrompt: input.systemPrompt,
      avatarSeed: input.avatarSeed,
      canCreateAgents: input.canCreateAgents,
      canAssignTasks: input.canAssignTasks,
      canEditFiles: input.canEditFiles,
      canRunCommands: input.canRunCommands,
    });
    // Materializa instructions/ no FS imediatamente
    try {
      ensureDefaultInstructions(agent);
    } catch (err) {
      console.warn('[agent:create] ensureDefaultInstructions falhou:', err);
    }
    return agent;
  });

  // Garante que o workspace tenha um CEO/Orchestrator. Idempotente: se já
  // existe um orquestrador, devolve ele em vez de criar um duplicado. Usado
  // pelo wizard de criação de workspace (sidebar) — sem isso, workspaces
  // criados fora do onboarding nascem "Sem CEO configurado".
  registerHandler('agent:create-orchestrator', (input) => {
    const existing = agentRepo.getOrchestrator(input.workspaceId);
    if (existing) return existing;
    return createFirstAgent({
      workspaceId: input.workspaceId,
      name: input.name,
      adapterType: input.adapterType,
      model: input.model,
      adapterConfig: input.adapterConfig ?? {},
    });
  });

  registerHandler('agent:update', ({ agentId, patch }) => {
    // Validação anti-ciclo: mudar reportsTo não pode criar um loop no
    // organograma (A→B→A) nem o agente reportar a si mesmo.
    if (patch.reportsTo) {
      if (patch.reportsTo === agentId) {
        throw new Error('Um agente não pode reportar a si mesmo.');
      }
      const agent = agentRepo.get(agentId);
      if (agent) {
        const all = agentRepo.listByWorkspace(agent.workspaceId);
        const byId = new Map(all.map((a) => [a.id, a]));
        // Sobe a cadeia a partir do novo gestor; se reencontrar o agente, é ciclo.
        let cursor: string | null = patch.reportsTo;
        const seen = new Set<string>();
        while (cursor) {
          if (cursor === agentId) {
            throw new Error('Mudança de gestor criaria um ciclo no organograma.');
          }
          if (seen.has(cursor)) break;
          seen.add(cursor);
          cursor = byId.get(cursor)?.reportsTo ?? null;
        }
      }
    }
    return agentRepo.update(agentId, patch);
  });

  registerHandler('agent:pause', ({ agentId, reason }) => {
    // Cancela quaisquer execuções de issue em andamento pra esse agente
    // antes de pausar — senão o status fica 'paused' mas o processo do CLI
    // continua rodando e gravando texto, dando feedback contraditório.
    try {
      const issueRepoLocal = new (require('../../db/repositories/issue.repo').IssueRepository)();
      const agent = agentRepo.get(agentId);
      if (agent) {
        const activeIssues = issueRepoLocal.listByWorkspace(agent.workspaceId, {
          assigneeAgentId: agentId,
        });
        const cancelFn = require('../../services/issue-execution-service').cancelIssueExecution;
        for (const issue of activeIssues) {
          if (issue.status === 'in_progress') {
            try {
              cancelFn(issue.id);
            } catch {
              /* já cancelada/inexistente — ignora */
            }
          }
        }
      }
    } catch (err) {
      console.warn('[agent:pause] cancel runs falhou:', err);
    }
    return agentRepo.pause(agentId, reason ?? 'manual');
  });

  registerHandler('agent:resume', ({ agentId }) => {
    return agentRepo.resume(agentId);
  });

  registerHandler('agent:delete', ({ agentId }) => {
    const agent = agentRepo.get(agentId);
    if (agent) {
      // Reaponta os subordinados pro orquestrador (CEO) — sem isso eles ficam
      // com reportsTo apontando pro agente morto e somem do organograma.
      const orchestrator = agentRepo.getOrchestrator(agent.workspaceId);
      const fallbackManager = orchestrator && orchestrator.id !== agentId ? orchestrator.id : null;
      for (const sub of agentRepo.listByWorkspace(agent.workspaceId)) {
        if (sub.reportsTo === agentId) {
          agentRepo.update(sub.id, { reportsTo: fallbackManager });
        }
      }
      // Remove o diretório de instructions/sessões do agente no disco.
      try {
        const dir = join(ORKESTRAL_WORKSPACES_DIR, agent.workspaceId, 'agents', agentId);
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[agent:delete] rmSync do dir do agente falhou:', err);
      }
    }
    agentRepo.delete(agentId);
    return { ok: true as const };
  });

  // -------- Instructions files --------
  registerHandler('agent:list-instructions', ({ agentId }) => {
    const agent = agentRepo.get(agentId);
    if (!agent) throw new Error(`Agente ${agentId} não encontrado`);
    // Lazy create dos defaults — útil pra agentes criados antes da feature
    ensureDefaultInstructions(agent);
    return listInstructions(agent.workspaceId, agent.id);
  });

  registerHandler('agent:read-instruction', ({ agentId, fileName }) => {
    const agent = agentRepo.get(agentId);
    if (!agent) throw new Error(`Agente ${agentId} não encontrado`);
    const content = readInstruction(agent.workspaceId, agent.id, fileName);
    return { content };
  });

  registerHandler('agent:write-instruction', ({ agentId, fileName, content }) => {
    const agent = agentRepo.get(agentId);
    if (!agent) throw new Error(`Agente ${agentId} não encontrado`);
    return writeInstruction(agent.workspaceId, agent.id, fileName, content);
  });

  registerHandler('agent:delete-instruction', ({ agentId, fileName }) => {
    const agent = agentRepo.get(agentId);
    if (!agent) throw new Error(`Agente ${agentId} não encontrado`);
    deleteInstruction(agent.workspaceId, agent.id, fileName);
    return { ok: true as const };
  });

  // -------- Heartbeat --------
  registerHandler('agent:run-heartbeat', async ({ agentId }) => {
    return await runHeartbeat({ agentId, source: 'manual' });
  });

  registerHandler('agent:list-heartbeat-runs', ({ agentId, limit }) => {
    return heartbeatRepo.listByAgent(agentId, limit ?? 50);
  });

  registerHandler('agent:get-heartbeat-stats', ({ agentId, days }) => {
    return heartbeatRepo.stats(agentId, days ?? 14);
  });

  registerHandler('agent:cancel-heartbeat', ({ runId }) => {
    const cancelled = cancelHeartbeat(runId);
    return { cancelled };
  });

  registerHandler('agent:get-activity', ({ agentId, limit }) => {
    return listAgentActivity(agentId, limit ?? 20);
  });

  registerHandler('agent:get-activity-stats', ({ agentId, days }) => {
    return getAgentActivityStats(agentId, days ?? 14);
  });

  // -------- API Keys --------
  registerHandler('agent:list-api-keys', ({ agentId }) => apiKeyRepo.listByAgent(agentId));

  registerHandler('agent:create-api-key', ({ agentId, name }) => {
    const agent = agentRepo.get(agentId);
    if (!agent) throw new Error(`Agente ${agentId} não encontrado`);
    return apiKeyRepo.create({ agentId, workspaceId: agent.workspaceId, name });
  });

  registerHandler('agent:revoke-api-key', ({ keyId }) => {
    apiKeyRepo.revoke(keyId);
    return { ok: true as const };
  });

  // -------- Reset sessões (remove todas sessões do agente) --------
  registerHandler('agent:reset-sessions', ({ agentId }) => {
    const sessions = sessionRepo.listByAgent(agentId);
    for (const s of sessions) {
      sessionRepo.delete(s.id);
    }
    return { deletedSessions: sessions.length };
  });

  // -------- Sessões --------
  registerHandler('session:list', ({ workspaceId }) => sessionRepo.listByWorkspace(workspaceId));

  registerHandler(
    'session:create',
    async ({ workspaceId, agentId, sessionId, title, firstMessage, scope, attachments }) => {
      const session = sessionRepo.create({
        id: sessionId,
        workspaceId,
        agentId,
        title: title ?? (firstMessage ? firstMessage.slice(0, 60).trim() : undefined),
      });
      let messagesRows = messageRepo.listBySession(session.id);

      // Dispara a primeira mensagem se houver texto OU anexos (antes, colar só
      // uma imagem criava uma conversa vazia e PERDIA a imagem — o guard exigia
      // texto e os attachments nem eram repassados).
      const hasContent = !!firstMessage && firstMessage.trim().length > 0;
      if (hasContent || (attachments && attachments.length > 0)) {
        await sendMessage({
          sessionId: session.id,
          content: firstMessage ?? '',
          scope,
          attachments,
        });
        messagesRows = messageRepo.listBySession(session.id);
      }

      return { session, messages: messagesRows };
    },
  );

  registerHandler('session:get', ({ sessionId }) => {
    const session = sessionRepo.get(sessionId);
    if (!session) return null;
    const messagesList = messageRepo.listBySession(sessionId);
    return { session, messages: messagesList };
  });

  registerHandler('session:delete', ({ sessionId }) => {
    sessionRepo.delete(sessionId);
    return { ok: true as const };
  });

  registerHandler('session:archive', ({ sessionId, archived }) => {
    sessionRepo.setArchived(sessionId, archived);
    return { ok: true as const };
  });

  // -------- Chat --------
  registerHandler('chat:send', async ({ sessionId, content, scope, attachments }) => {
    return sendMessage({ sessionId, content, scope, attachments });
  });

  registerHandler('chat:cancel', ({ runId, pause }) => {
    let cancelled = cancelRun(runId, { pause });
    if (!cancelled) {
      try {
        cancelled = cancelIssueExecutionByRunId(runId);
      } catch (err) {
        console.warn('[chat:cancel] falha ao tentar cancelar issue run:', err);
      }
    }
    return { cancelled };
  });

  // -------- Fila de mensagens (persistida no MAIN) --------
  registerHandler('chat:enqueue', async ({ sessionId, content, scope, attachments, kind }) => {
    return enqueueChatMessage({ sessionId, content, scope, attachments, kind });
  });

  registerHandler('chat:queue-list', ({ sessionId }) => {
    return { items: listChatQueue(sessionId) };
  });

  registerHandler('chat:queue-set-kind', ({ itemId, kind }) => {
    setChatQueueItemKind(itemId, kind);
    return { ok: true as const };
  });

  registerHandler('chat:queue-cancel', ({ itemId }) => {
    cancelChatQueueItem(itemId);
    return { ok: true as const };
  });

  registerHandler('hiring:apply-plan', async ({ sessionId, responseText, approved }) => {
    const session = sessionRepo.get(sessionId);
    if (!session) throw new Error(`Sessao ${sessionId} nao encontrada`);
    const orchestrator = agentRepo.get(session.agentId);
    if (!orchestrator) throw new Error(`Agente ${session.agentId} nao encontrado`);
    // Os specs do time são capturados na GERAÇÃO (texto bruto do CEO, antes de
    // a UI remover os blocos <orkestral:create-agent> pra exibição) e guardados
    // no payload da atividade 'proposal.pending'. Lemos DALI — não do
    // `responseText`, que chega do renderer já sem os blocos (era esse o bug:
    // parse no texto limpo nunca achava agentes → created sempre 0).
    const pending = activityRepo
      .listByWorkspace(session.workspaceId, 100)
      .filter((e) => e.kind === 'proposal.pending' && e.subjectId === sessionId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    // Idempotência (botão de aprovar perde o estado no remount → 2-3 cliques):
    // sem isso, cada re-fire re-materializava / re-pedia blocos ao CEO, gerando a
    // mesma "mensagem de criar plano" 2-3 vezes. A regra é pura em decideHiringApply.
    const applied = pending
      ? null
      : activityRepo.getAppliedProposal(session.workspaceId, sessionId);
    const decision = decideHiringApply({
      hasPendingProposal: !!pending,
      hasAppliedMarker: !!applied,
      isApplyInFlight: applyingHiringSessions.has(sessionId),
    });
    if (decision === 'skip-already-applied') {
      const names = (applied?.payload as { names?: string[] } | undefined)?.names ?? [];
      return { created: 0, names, forgeNeeded: false };
    }
    if (decision === 'skip-in-flight') return { created: 0, names: [], forgeNeeded: false };
    applyingHiringSessions.add(sessionId);
    try {
      const storedAgents =
        (pending?.payload as { agents?: ParsedHiringPlanDecision['agents'] } | undefined)?.agents ??
        [];
      // Secundário: tenta o texto recebido (normalmente sem blocos) só por garantia.
      const parsed = parseHiringPlanDecision(responseText);
      // Usuário clicou "Aprovar": a decisão dele MANDA, não o marcador do modelo.
      const willApprove = approved || !!parsed?.approved;
      let agents = storedAgents.length ? storedAgents : (parsed?.agents ?? []);
      // Aprovado mas sem specs (proposta só em prosa, ou proposta antiga gerada
      // antes de guardarmos os specs no payload): re-pede os blocos ao CEO e
      // ESPERA a resposta. Cria o time REAL tailored ao projeto — sem fallback.
      if (willApprove && agents.length === 0) {
        agents = await requestHiringTeamBlocks(sessionId);
      }
      const created = materializeApprovedHiringPlan({
        workspaceId: session.workspaceId,
        orchestrator,
        decision: { approved: willApprove, agents },
        sessionId,
      });
      // Consome a pendência + grava o marcador aplicado (idempotência durável dos
      // re-fires sequenciais). Só quando de fato decidiu aprovar.
      if (willApprove) {
        activityRepo.markProposalApplied(
          session.workspaceId,
          sessionId,
          created.map((a) => a.name),
          mt('Time contratado', 'Team hired'),
        );
      }
      // Criou agente(s) Forge mas o modelo não está baixado? O card oferece baixar
      // (~1.1GB); até lá rodam no premium (fallback de runtime já existe).
      const forgeNeeded =
        created.some((a) => a.adapterType === 'orkestral_local') && !isForgeBundled();
      return { created: created.length, names: created.map((a) => a.name), forgeNeeded };
    } finally {
      applyingHiringSessions.delete(sessionId);
    }
  });
}
