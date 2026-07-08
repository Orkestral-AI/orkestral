/**
 * Verificação de OBJETIVO (Goal) pelo CEO. Quando todas as issues vinculadas a um
 * objetivo concluem, o CEO valida a ENTREGA contra o objetivo (o que o usuário
 * pediu) — não só "as tasks terminaram". Marca achieved se entregue, ou abre as
 * issues de gap. Reusado pelo handler `goal:verify` (manual) E pelo auto-disparo
 * quando o progresso chega a 100% (maybeAutoVerifyGoal).
 *
 * Dedup por `goal.verifySessionId`: lança no MÁXIMO uma sessão de verificação por
 * objetivo (não re-spawna o CEO a cada recálculo de progresso).
 */
import { GoalRepository } from '../db/repositories/routine-goal.repo';
import { AgentRepository } from '../db/repositories/agent.repo';
import { ChatSessionRepository } from '../db/repositories/session.repo';
import { WorkspaceRepository } from '../db/repositories/workspace.repo';
import { ActivityRepository } from '../db/repositories/activity.repo';
import { IssueRepository } from '../db/repositories/issue.repo';

const goalRepo = new GoalRepository();
const agentRepo = new AgentRepository();
const sessionRepo = new ChatSessionRepository();
const workspaceRepo = new WorkspaceRepository();
const activityRepo = new ActivityRepository();

/**
 * Lança a sessão do CEO pra VERIFICAR o objetivo contra a entrega. Idempotente por
 * `verifySessionId` (não re-lança). Retorna a sessão (nova ou existente) ou null se
 * não há CEO/objetivo. Não lança — verificar jamais derruba o fluxo que a disparou.
 */
export function launchGoalVerification(goalId: string): { sessionId: string } | null {
  try {
    const goal = goalRepo.get(goalId);
    if (!goal) return null;
    // Dedup: já há uma verificação em andamento/feita pra este objetivo.
    if (goal.verifySessionId) {
      const existing = sessionRepo.get(goal.verifySessionId);
      if (existing) return { sessionId: existing.id };
    }
    const ceo = agentRepo.getOrchestrator(goal.workspaceId);
    if (!ceo) return null;
    const ws = workspaceRepo.list().find((w) => w.id === goal.workspaceId);

    // Prompt BOUNDED: verificação rápida via list_issues, sem ler código e sem
    // delegar pra workers (era isso que fazia o CEO girar 20min sem entregar).
    const prompt = [
      `@${ceo.name} Você é o CEO/Orquestrador.`,
      '',
      `## Tarefa: VERIFICAR conclusão de um objetivo`,
      '',
      `Objetivo: "${goal.title}"`,
      goal.description ? `Contexto (o que o usuário pediu): ${goal.description}` : null,
      'As issues vinculadas a este objetivo concluíram.',
      '',
      'Faça uma verificação RÁPIDA (não leia código, não abra/derribe workers):',
      '1. Chame list_issues e confira se as issues deste objetivo estão todas "done".',
      '2. Avalie se a ENTREGA satisfaz o objetivo — o que o usuário pediu — não só se as tasks terminaram.',
      `3. Se sim → chame update_goal_status com goal_id="${goal.id}" e status="achieved", e confirme em 1-2 linhas.`,
      `4. Se faltar algo → NÃO marque achieved; liste o que falta e crie as issues de gap via create_issue com goal_id="${goal.id}".`,
      '',
      'Seja objetivo: no máximo 1-2 chamadas de tool. NÃO delegue pra outros agentes. Responda em português, curto.',
    ]
      .filter(Boolean)
      .join('\n');

    const session = sessionRepo.create({
      workspaceId: goal.workspaceId,
      agentId: ceo.id,
      title: `Verificar objetivo: ${goal.title}`,
      directory: ws?.path ?? undefined,
    });
    goalRepo.update(goal.id, { verifySessionId: session.id });
    activityRepo.log({
      workspaceId: goal.workspaceId,
      kind: 'goal.verify_requested',
      subjectKind: 'goal',
      subjectId: goal.id,
      title: `CEO verificando objetivo: ${goal.title}`,
    });
    // chat-service importado LAZY: ele importa o mcp-server, que importa este
    // serviço — o import dinâmico quebra o ciclo estático (e o envio já é async).
    void import('./chat-service')
      .then(({ sendMessage }) => sendMessage({ sessionId: session.id, content: prompt }))
      .catch((err) => console.warn('[goal-verify] envio falhou:', err));
    return { sessionId: session.id };
  } catch (err) {
    console.warn('[goal-verify] falhou ao lançar verificação:', err);
    return null;
  }
}

/**
 * Recalcula o progresso do objetivo e, se acabou de chegar a 100% e ainda está
 * ATIVO (e sem verificação anterior), dispara o CEO pra validar a entrega. É o
 * "o CEO SEMPRE valida a entrega ao concluir". Chamado após uma issue mudar de
 * status (não na criação). Não lança.
 */
export function maybeAutoVerifyGoal(goalId: string | null | undefined): void {
  if (!goalId) return;
  try {
    const progress = goalRepo.recalcProgress(goalId);
    if (progress < 100) return;
    const goal = goalRepo.get(goalId);
    if (!goal || goal.status !== 'active' || goal.verifySessionId) return;
    launchGoalVerification(goalId);
  } catch (err) {
    console.warn('[goal-verify] auto-verify falhou:', err);
  }
}

/** Cap de turnos de convergência por objetivo — junto com o token_budget, garante
 * que o loop "CEO re-entra com o delta" TERMINA mesmo sem teto de tokens. */
const MAX_GOAL_CONVERGENCE_TURNS = 5;
/** Rate-limit entre turnos de convergência do MESMO objetivo. */
const CONVERGENCE_MIN_INTERVAL_MS = 10 * 60_000;

/**
 * LOOP DE CONVERGÊNCIA (HORIZON Fase 2 — horizonte longo): o plano assentou mas o
 * objetivo NÃO fechou (progress < 100%). Em vez de morrer em silêncio, o CEO
 * re-entra com o DELTA — o que falta entre o estado atual e o objetivo — e abre
 * as issues do gap. Orçamento honesto: se `token_budget` foi definido e estourou,
 * PARA e reporta com o número (não promete). Caps: MAX_GOAL_CONVERGENCE_TURNS por
 * objetivo + rate-limit por lastConvergenceAt. Best-effort: nunca lança.
 */
export function maybeRequestGoalConvergence(goalId: string | null | undefined): void {
  if (!goalId) return;
  try {
    const progress = goalRepo.recalcProgress(goalId);
    if (progress >= 100) return; // 100% → caminho da verificação (maybeAutoVerifyGoal)
    const goal = goalRepo.get(goalId);
    if (!goal || goal.status !== 'active') return;
    if (goal.lastConvergenceAt) {
      const elapsed = Date.now() - new Date(goal.lastConvergenceAt).getTime();
      if (elapsed < CONVERGENCE_MIN_INTERVAL_MS) return;
    }
    const ceo = agentRepo.getOrchestrator(goal.workspaceId);
    if (!ceo) return;

    const spent = goalRepo.spentTokens(goal.id);
    const budgetLine =
      goal.tokenBudget && goal.tokenBudget > 0
        ? `Orçamento: ${spent.toLocaleString('en-US')} de ${goal.tokenBudget.toLocaleString('en-US')} tokens gastos.`
        : `Tokens gastos até aqui: ${spent.toLocaleString('en-US')} (sem teto definido).`;
    const budgetBlown = !!goal.tokenBudget && goal.tokenBudget > 0 && spent >= goal.tokenBudget;
    const turnsExhausted = goal.convergenceCount >= MAX_GOAL_CONVERGENCE_TURNS;
    const deadlinePassed = !!goal.dueDate && new Date(goal.dueDate).getTime() < Date.now();

    // Registra o turno ANTES de disparar (idempotência: duas épicas assentando
    // quase juntas não geram dois turnos — a segunda cai no rate-limit).
    goalRepo.bumpConvergence(goal.id);

    // Sessão do CEO: reusa a de planejamento do objetivo; senão cria dedicada.
    const existing = goal.planSessionId ? sessionRepo.get(goal.planSessionId) : null;
    const session =
      existing ??
      sessionRepo.create({
        workspaceId: goal.workspaceId,
        agentId: ceo.id,
        title: `Convergência do objetivo: ${goal.title}`,
        directory: workspaceRepo.list().find((w) => w.id === goal.workspaceId)?.path ?? undefined,
      });
    if (!existing) goalRepo.update(goal.id, { planSessionId: session.id });

    const stop = budgetBlown || turnsExhausted;
    const prompt = stop
      ? [
          '[[GOAL_CONVERGENCE_HIDDEN]]',
          `O objetivo "${goal.title}" PAROU em ${progress}% e o loop de convergência ESGOTOU ` +
            (budgetBlown
              ? `o orçamento (${budgetLine})`
              : `o cap de ${MAX_GOAL_CONVERGENCE_TURNS} turnos de replanejamento`) +
            '. NÃO abra issues novas e NÃO chame ferramentas de escrita.',
          '',
          'Escreva pro usuário um REPORT honesto e curto: o que foi entregue, o que falta pro objetivo, ' +
            `o número exato (${budgetLine}) e as 1-3 decisões que só ele pode tomar pra continuar (aumentar orçamento, cortar escopo, aceitar como está).`,
        ].join('\n')
      : [
          '[[GOAL_CONVERGENCE_HIDDEN]]',
          `O trabalho planejado ASSENTOU mas o objetivo "${goal.title}" está em ${progress}% — o objetivo NÃO fechou sozinho.`,
          goal.description ? `O que o usuário pediu: ${goal.description}` : '',
          budgetLine,
          deadlinePassed ? `⚠️ O prazo (${goal.dueDate}) já passou.` : '',
          '',
          'Seu turno de CONVERGÊNCIA (o delta, não um plano novo do zero):',
          '1. Chame list_issues e compare o estado real com o objetivo: o que EXATAMENTE falta?',
          `2. Se a entrega na prática JÁ satisfaz o objetivo → update_goal_status com goal_id="${goal.id}" e status="achieved" + 1 linha de confirmação.`,
          `3. Se falta trabalho → abra SÓ as issues do gap (create_issue_plan ou create_issue, sempre com goal_id="${goal.id}"), pequenas e focadas, com assignee. NADA de refazer o que já está done.`,
          '4. Responda em 2-4 linhas o que decidiu. Sem prosa longa.',
        ]
          .filter(Boolean)
          .join('\n');

    activityRepo.log({
      workspaceId: goal.workspaceId,
      kind: stop ? 'goal.convergence_stopped' : 'goal.convergence_requested',
      subjectKind: 'goal',
      subjectId: goal.id,
      title: stop
        ? `Convergência ENCERRADA (orçamento/turnos): ${goal.title}`
        : `CEO convergindo objetivo (${progress}%): ${goal.title}`,
      payload: { progress, spentTokens: spent, tokenBudget: goal.tokenBudget },
    });
    void import('./chat-service')
      .then(({ sendMessage }) => sendMessage({ sessionId: session.id, content: prompt }))
      .catch((err) => console.warn('[goal-converge] envio falhou:', err));
  } catch (err) {
    console.warn('[goal-converge] convergência falhou:', err);
  }
}

/**
 * VARREDURA DE BOOT (retomada fria do horizonte longo): objetivos ativos com
 * progresso < 100% e NENHUMA issue aberta vinculada ficaram órfãos (o app fechou
 * entre "plano assentou" e "convergir"). Re-dispara a convergência de cada um —
 * os caps/rate-limit acima continuam valendo.
 */
export function sweepStalledGoals(): number {
  let swept = 0;
  try {
    const issueRepo = new IssueRepository();
    for (const ws of workspaceRepo.listAll()) {
      for (const goal of goalRepo.listByWorkspace(ws.id)) {
        if (goal.status !== 'active' || goal.progress >= 100) continue;
        const open = issueRepo
          .listByWorkspace(ws.id)
          .some(
            (i) =>
              i.goalId === goal.id &&
              i.status !== 'done' &&
              i.status !== 'cancelled' &&
              i.status !== 'blocked',
          );
        if (open) continue; // ainda há trabalho andando — a convergência vem no assentamento
        maybeRequestGoalConvergence(goal.id);
        swept += 1;
      }
    }
  } catch (err) {
    console.warn('[goal-converge] sweep de boot falhou:', err);
  }
  return swept;
}
