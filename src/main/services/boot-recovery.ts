import { MessageRepository } from '../db/repositories/message.repo';
import { IssueRepository } from '../db/repositories/issue.repo';
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import { postAgentMessageToSession } from './chat-service';
import type { Issue } from '../../shared/types';

interface RecoveryResult {
  interruptedMessages: number;
  interruptedIssueRuns: number;
}

function originSessionIdOf(issue: Issue): string | null {
  const meta = issue.metadata as { originSessionId?: string } | null | undefined;
  return meta?.originSessionId ?? null;
}

/**
 * Recupera estado de trabalho após fechamento/crash do app: encerra os runs presos,
 * devolve as issues interrompidas pra `todo` (retomáveis pelo resumeInterruptedWork)
 * e avisa o usuário.
 *
 * O aviso no CHAT é um RESUMO conversacional por sessão (1 mensagem agrupando as
 * issues daquela conversa) — NÃO um parágrafo por issue, que entupia o chat. O
 * detalhe por-issue fica na timeline da própria issue (por trás), não no chat.
 */
export function recoverInterruptedWork(): RecoveryResult {
  const messageRepo = new MessageRepository();
  const issueRepo = new IssueRepository();
  const workspaceRepo = new WorkspaceRepository();

  const interruptedMessages = messageRepo.cleanupStreamingOrphansDetailed();
  const interruptedRunIds = new Set(interruptedMessages.map((msg) => msg.runId).filter(Boolean));
  let interruptedIssueRuns = 0;
  // sessionId → nº de issues paradas daquela conversa (pro resumo único no chat).
  const perSession = new Map<string, number>();

  for (const workspace of workspaceRepo.listAll()) {
    // Varre runs ATIVOS (queued OU running): com a fila persistindo 'queued', um
    // crash deixa runs enfileirados órfãos que também precisam ser limpos.
    const running = issueRepo.listActiveRunsByWorkspace(workspace.id);
    for (const { run, issue } of running) {
      issueRepo.finishRun(run.id, {
        status: 'cancelled',
        errorMessage: 'Interrompida ao fechar o Orkestral.',
        outputSummary: 'Interrompida no boot recovery.',
        exitReason: 'interrupted_on_boot',
      });
      // RETOMÁVEL: volta pra `todo` (não `blocked`) pra o resumeInterruptedWork
      // re-disparar a execução de onde parou. interruptedRun marca o histórico sem
      // virar estado terminal. Done/cancelled são respeitados.
      if (issue.status !== 'done' && issue.status !== 'cancelled') {
        issueRepo.update(issue.id, {
          status: 'todo',
          metadata: {
            ...((issue.metadata as Record<string, unknown>) ?? {}),
            interruptedRun: {
              runId: run.id,
              interruptedAt: new Date().toISOString(),
              reason: 'app-closed-or-crashed',
            },
          },
        });
      }
      // Detalhe CONCISO na timeline da issue (1 linha) — fica por trás da issue.
      issueRepo.addComment({
        issueId: issue.id,
        authorKind: 'system',
        body: '⚠️ Execução interrompida ao fechar o app — retomando automaticamente de onde parou.',
      });

      const sessionId = originSessionIdOf(issue);
      if (sessionId && !interruptedRunIds.has(run.id)) {
        perSession.set(sessionId, (perSession.get(sessionId) ?? 0) + 1);
      }
      interruptedIssueRuns += 1;
    }
  }

  // Um RESUMO conversacional por sessão (não um por issue).
  for (const [sessionId, count] of perSession) {
    const summary =
      count === 1
        ? '⚠️ Uma issue ficou pausada quando o app fechou — já retomei, continuando de onde parou. Revise *Code changes* se houver alterações locais.'
        : `⚠️ ${count} issues ficaram pausadas quando o app fechou — já retomei todas, continuando de onde pararam. Revise *Code changes* se houver alterações locais.`;
    try {
      postAgentMessageToSession(sessionId, summary);
    } catch (err) {
      console.warn('[boot-recovery] falha ao reportar retomada no chat:', err);
    }
  }

  return {
    interruptedMessages: interruptedMessages.length,
    interruptedIssueRuns,
  };
}
