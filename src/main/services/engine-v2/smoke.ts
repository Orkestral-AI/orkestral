/**
 * Engine v2: smoke test VIVO, dentro do app (Electron).
 *
 * Gated por env. Roda uma fatia de verdade: o premium configurado (CLI) planeja/conduz e o
 * FORGE LOCAL executa (node-llama-cpp via Electron). Loga tudo no stdout do main, pra a
 * gente ver o Forge executando + o numero de economia real, sem precisar de UI/devtools.
 *
 * Uso: ENGINE_V2_SMOKE=/caminho/do/repo ENGINE_V2_INTENT="cria src/x.ts ..." <subir o app>
 */
import { WorkspaceRepository } from '../../db/repositories/workspace.repo';
import { AgentRepository } from '../../db/repositories/agent.repo';
import { isPremiumAdapter } from './premium-runner';
import { runEngineV2InApp } from './run-in-app';

const TAG = '[engine-v2 smoke]';

export async function runEngineV2Smoke(): Promise<void> {
  const projectRoot = process.env.ENGINE_V2_SMOKE;
  const intent = process.env.ENGINE_V2_INTENT;
  if (!projectRoot || !intent) {
    console.log(`${TAG} faltou ENGINE_V2_SMOKE (repo) ou ENGINE_V2_INTENT.`);
    return;
  }

  const wsRepo = new WorkspaceRepository();
  const agRepo = new AgentRepository();
  let workspaceId: string | null = process.env.ENGINE_V2_WS ?? null;
  if (!workspaceId) {
    for (const ws of wsRepo.list()) {
      const agents = agRepo.listByWorkspace(ws.id);
      if (agents.some((a) => a.adapterType && isPremiumAdapter(a.adapterType))) {
        workspaceId = ws.id;
        break;
      }
    }
  }
  if (!workspaceId) {
    console.log(`${TAG} nenhum workspace com agente premium (nao-Forge) configurado.`);
    return;
  }

  console.log(`${TAG} START ws=${workspaceId} repo=${projectRoot}`);
  console.log(`${TAG} intent="${intent}"`);

  // Caminho CHAT: dispara via startEngineV2Build (a engine decide build vs responder).
  if (process.env.ENGINE_V2_CHAT_SMOKE) {
    const { startEngineV2Build } = await import('../chat-service');
    const { ChatSessionRepository } = await import('../../db/repositories/session.repo');
    const sessionRepo = new ChatSessionRepository();
    const sessions = sessionRepo.listByWorkspace(workspaceId);
    const orch = agRepo.getOrchestrator(workspaceId);
    const sessionId =
      sessions[0]?.id ??
      (orch
        ? sessionRepo.create({ workspaceId, agentId: orch.id, title: 'engine-v2 chat smoke' }).id
        : null);
    if (!sessionId) {
      console.log(`${TAG} sem sessao/orquestrador pro chat smoke.`);
      return;
    }
    console.log(`${TAG} CHAT build na sessao ${sessionId}`);
    startEngineV2Build({ sessionId, workspaceId, projectRoot, intent });
    return;
  }
  const t0 = Date.now();
  try {
    const res = await runEngineV2InApp({
      workspaceId,
      intent,
      projectRoot,
      onCheckpoint: (s) =>
        console.log(
          `${TAG} [${s.status === 'done' ? 'OK' : 'BLOCKED'}] ${s.checkboxId}: ${s.instruction} (${s.remaining} left)`,
        ),
      onPreviewReady: (p) => console.log(`${TAG} preview: ${p.mode} ${p.url ?? ''} — ${p.reason}`),
    });
    console.log(`${TAG} DONE in ${Math.round((Date.now() - t0) / 1000)}s`);
    console.log(
      `${TAG} planned=${res.planned} done=${res.totalDone} blocked=${res.totalBlocked} previewLaunched=${res.previewLaunched}`,
    );
    console.log(`${TAG} premiumTokens=${res.premiumTokens} localTokens=${res.localTokens}`);
    console.log(`${TAG} ${res.economyLine}`);
    if (!res.planned) console.log(`${TAG} plan rejected: ${res.planViolations.join(' | ')}`);
  } catch (e) {
    console.log(`${TAG} ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}
