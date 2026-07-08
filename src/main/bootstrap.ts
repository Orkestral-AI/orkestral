import { initDatabase } from './db/connection';
import { AgentRunRepository } from './db/repositories/run.repo';
import { HeartbeatRunRepository } from './db/repositories/heartbeat-run.repo';
import { kbAnalysisJobRepo } from './db/repositories/kb-analysis-job.repo';
import { WorkspaceRepository } from './db/repositories/workspace.repo';
import { WorkspaceSourceRepository } from './db/repositories/workspace-source.repo';
import { backfillExecutionPlanChecklists } from './services/issue-from-chat';
import { startHeartbeatScheduler } from './services/heartbeat-service';
import { startRoutineScheduler } from './services/routine-service';
import { startMonitorScheduler } from './services/monitor-scheduler';
import { initChannelService } from './services/channels/channel-manager';
import { resumeEmbeddingQueueOnBoot } from './services/kb-embedding-queue';
import { ensureMcpServerStarted } from './services/mcp-server';
import {
  syncWorkspaceTeamForSources,
  reconcileSourceRolesByName,
} from './services/source-team-sync';
import { recoverInterruptedWork } from './services/boot-recovery';

/**
 * Boot Node-puro da plataforma — sem dependência de Electron. Roda igual no app
 * GUI e no CLI headless (este passa `headless: true`). Faz o DB, a recuperação de
 * trabalho interrompido, a sincronização de times por source, os schedulers, os
 * canais, a fila de embedding, o MCP e a retomada de execuções pendentes.
 *
 * `opts.headless` ainda não muda o comportamento (o boot é o mesmo nos dois modos),
 * mas é mantido pra o CLI passar `true` e pra futuras divergências.
 */
export function bootstrapServices(opts: { headless: boolean }): void {
  void opts.headless;

  initDatabase();

  // Cleanup de mensagens/runs presas em streaming/running de execuções
  // anteriores (app fechado no meio, crash, etc.). Sem isso o input do
  // chat pode ficar travado em modo "cancel" indefinidamente.
  const interrupted = recoverInterruptedWork();
  const orphanRuns = new AgentRunRepository().cleanupRunningOrphans();
  const orphanHbs = new HeartbeatRunRepository().cleanupRunningOrphans();
  const orphanAnalyses = kbAnalysisJobRepo.markBootOrphansFailed();
  // Backfill: issues antigas com checklist na descrição viram componente de Tasks.
  try {
    const backfilled = backfillExecutionPlanChecklists();
    if (backfilled > 0) {
      console.log(
        `[boot] backfill: ${backfilled} issues com checklist migradas pra execution-plan.`,
      );
    }
  } catch (err) {
    console.warn('[boot] backfill de checklists falhou:', err);
  }
  if (
    interrupted.interruptedMessages > 0 ||
    interrupted.interruptedIssueRuns > 0 ||
    orphanRuns > 0 ||
    orphanHbs > 0 ||
    orphanAnalyses > 0
  ) {
    console.log(
      `[boot] recovery: ${interrupted.interruptedMessages} mensagens + ${interrupted.interruptedIssueRuns} issue runs + ${orphanRuns} chat runs + ${orphanHbs} heartbeats + ${orphanAnalyses} análises de KB órfãs marcados como interrupted/cancelled/failed.`,
    );
  }
  try {
    const sourceRepo = new WorkspaceSourceRepository();
    for (const workspace of new WorkspaceRepository().listAll()) {
      if (sourceRepo.listByWorkspace(workspace.id).length === 0) continue;
      // Conserta roles antigas erradas (ex.: bug `axios`→mobile) ANTES de
      // sincronizar o time, pra os agentes nascerem cobrindo a role certa.
      reconcileSourceRolesByName(workspace.id);
      syncWorkspaceTeamForSources(workspace.id, 'boot-sync');
    }
  } catch (err) {
    console.warn('[boot] sync inicial de agentes/sources falhou:', err);
  }

  startHeartbeatScheduler();
  startRoutineScheduler();
  startMonitorScheduler();
  // Religa contas de canais (WhatsApp) já pareadas e liga o bus de saída.
  try {
    initChannelService();
  } catch (err) {
    console.warn('[boot] init do serviço de canais falhou:', err);
  }
  // Retoma indexação semântica pendente em BACKGROUND no boot — sem depender
  // de abrir a Base de conhecimento.
  try {
    resumeEmbeddingQueueOnBoot();
  } catch (err) {
    console.warn('[boot] resume da fila de embedding falhou:', err);
  }
  // Sobe MCP HTTP local — agentes vão usar via --mcp-config no spawn
  ensureMcpServerStarted().catch((err) =>
    console.error('[boot] MCP server falhou ao iniciar:', err),
  );
  // RETOMADA NO BOOT (`resumeInterruptedWork`) NÃO roda aqui de propósito: ela
  // re-dispara o trabalho parado e precisa acontecer DEPOIS do IPC/schedulers/window
  // prontos. Cada caller (GUI em index.ts, daemon `serve` em cli.ts) a invoca no
  // momento certo — a GUI por último, após a janela subir.
}
