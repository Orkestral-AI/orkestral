import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDatabase, getSqlite } from '../connection';
import { issues, issueComments, issueRuns } from '../schema';
import { AgentRepository } from './agent.repo';
import type {
  Issue,
  IssueAttachment,
  IssueComment,
  IssueMetadata,
  IssuePriority,
  IssueRun,
  IssueStatus,
} from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToIssue(row: typeof issues.$inferSelect): Issue {
  let metadata: IssueMetadata | null = null;
  if (row.metadataJson) {
    try {
      metadata = JSON.parse(row.metadataJson) as IssueMetadata;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    issueKey: row.issueKey,
    title: row.title,
    description: row.description,
    status: row.status as IssueStatus,
    priority: row.priority as IssuePriority,
    labels: row.labels ?? [],
    assigneeAgentId: row.assigneeAgentId,
    reporterAgentId: row.reporterAgentId,
    parentIssueId: row.parentIssueId,
    goalId: row.goalId,
    displayKey: row.displayKey ?? null,
    childOrdinal: row.childOrdinal ?? null,
    dueDate: row.dueDate,
    completedAt: row.completedAt,
    metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToRun(row: typeof issueRuns.$inferSelect): IssueRun {
  return {
    id: row.id,
    issueId: row.issueId,
    agentId: row.agentId,
    status: row.status as IssueRun['status'],
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorMessage: row.errorMessage,
    outputSummary: row.outputSummary,
    exitCode: row.exitCode,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costUsd: row.costUsd,
    toolCallCount: row.toolCallCount,
    adapterType: row.adapterType,
    exitReason: row.exitReason,
  };
}

function rowToComment(row: typeof issueComments.$inferSelect): IssueComment {
  return {
    id: row.id,
    issueId: row.issueId,
    authorAgentId: row.authorAgentId,
    authorKind: row.authorKind,
    body: row.body,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    createdAt: row.createdAt,
  };
}

/** SQL do sequenciador atômico de issue_key — exportado pra o teste casar a string. */
export const NEXT_ISSUE_KEY_SQL =
  'INSERT INTO issue_counters (workspace_id, last_value) VALUES (?, 1) ' +
  'ON CONFLICT(workspace_id) DO UPDATE SET last_value = last_value + 1 RETURNING last_value';

/** Pega o próximo issue_key pra um workspace, incrementando atomicamente. */
function nextIssueKey(workspaceId: string): number {
  // UPSERT atômico numa única statement: INSERT...ON CONFLICT DO UPDATE...RETURNING
  // incrementa e lê o novo valor sem janela de SELECT-then-UPDATE — mata o
  // lost-update (issueKeys duplicadas) entre escritores concorrentes (app + core MCP).
  const sqlite = getSqlite();
  const row = sqlite.prepare(NEXT_ISSUE_KEY_SQL).get(workspaceId) as { last_value: number };
  return row.last_value;
}

/**
 * Próximo display_key pra uma issue TOP-LEVEL do workspace: max + 1 entre as
 * raízes (parent_issue_id NULL). Persistido e estável — apagar uma raiz deixa
 * buraco, não renumera. Sub-issues não entram nessa contagem.
 */
function nextDisplayKey(workspaceId: string): number {
  const db = getDatabase();
  const row = db
    .select({ m: sql<number>`COALESCE(MAX(${issues.displayKey}), 0)` })
    .from(issues)
    .where(and(eq(issues.workspaceId, workspaceId), isNull(issues.parentIssueId)))
    .get();
  return (row?.m ?? 0) + 1;
}

/**
 * Próximo child_ordinal entre os filhos diretos de `parentId`: max + 1.
 * Persistido e estável (estilo Linear).
 */
function nextChildOrdinal(parentId: string): number {
  const db = getDatabase();
  const row = db
    .select({ m: sql<number>`COALESCE(MAX(${issues.childOrdinal}), 0)` })
    .from(issues)
    .where(eq(issues.parentIssueId, parentId))
    .get();
  return (row?.m ?? 0) + 1;
}

/** Patch de fim de run — compartilhado por finishRun e finishRunAndSetStatus. */
type FinishRunPatch = {
  status: IssueRun['status'];
  errorMessage?: string | null;
  outputSummary?: string | null;
  exitCode?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  toolCallCount?: number | null;
  adapterType?: string | null;
  exitReason?: string | null;
};

export class IssueRepository {
  listByWorkspace(
    workspaceId: string,
    options: { status?: IssueStatus; assigneeAgentId?: string } = {},
  ): Issue[] {
    const db = getDatabase();
    const conditions = [eq(issues.workspaceId, workspaceId)];
    if (options.status) conditions.push(eq(issues.status, options.status));
    if (options.assigneeAgentId)
      conditions.push(eq(issues.assigneeAgentId, options.assigneeAgentId));
    const rows = db
      .select()
      .from(issues)
      .where(and(...conditions))
      .orderBy(desc(issues.updatedAt))
      .all();
    return rows.map(rowToIssue);
  }

  get(id: string): Issue | null {
    const db = getDatabase();
    const row = db.select().from(issues).where(eq(issues.id, id)).get();
    return row ? rowToIssue(row) : null;
  }

  /**
   * Issues com `monitorSchedule` definido (hourly/daily/weekly). Lidas pelo
   * monitor-scheduler pra disparar a ação de monitoramento quando due. O schedule
   * não vive no tipo `Issue` (é relação), então vai pareado.
   */
  listWithMonitorSchedule(): { issue: Issue; schedule: string }[] {
    const db = getDatabase();
    const rows = db.select().from(issues).where(isNotNull(issues.monitorSchedule)).all();
    return rows
      .filter((r) => !!r.monitorSchedule)
      .map((r) => ({ issue: rowToIssue(r), schedule: r.monitorSchedule as string }));
  }

  /** Retorna todos os subtasks (filhos diretos) de uma issue. */
  listChildren(parentId: string): Issue[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(issues)
      .where(eq(issues.parentIssueId, parentId))
      .orderBy(asc(issues.createdAt))
      .all();
    return rows.map(rowToIssue);
  }

  /**
   * Rollup de épica: conclui a pai quando todos os filhos terminam (e reabre se
   * um filho voltar). Retorna o novo status se mudou, senão null.
   */
  syncEpicStatus(parentId: string | null | undefined): IssueStatus | null {
    if (!parentId) return null;
    const parent = this.get(parentId);
    if (!parent) return null;
    const children = this.listChildren(parentId);
    if (children.length === 0) return null;
    // Regra ÚNICA de rollup (compartilhada com syncParentEpic): épico = done
    // quando TODOS os filhos estão em estado terminal (done OU cancelled) E ao
    // menos um está done. Um épico com todos os filhos cancelados NÃO vira done.
    const allTerminal = children.every((c) => c.status === 'done' || c.status === 'cancelled');
    const anyDone = children.some((c) => c.status === 'done');
    const shouldBeDone = allTerminal && anyDone;
    if (shouldBeDone && parent.status !== 'done') {
      this.update(parentId, { status: 'done' });
      return 'done';
    }
    if (!shouldBeDone && parent.status === 'done') {
      this.update(parentId, { status: 'in_progress' });
      // Rollup PROFUNDO (árvores de sub-épicas): reabrir a pai também reabre os
      // avós. O caminho done→ já cascateia (update chama syncParentEpic), mas o
      // reopen não passava do 1º nível — um avô ficava 'done' com neto reaberto.
      if (parent.parentIssueId) this.syncEpicStatus(parent.parentIssueId);
      return 'in_progress';
    }
    return null;
  }

  /** Rollup de épica em todo o workspace (lazy, no issue:list). */
  syncAllEpics(workspaceId: string): void {
    const db = getDatabase();
    const parentIds = db
      .selectDistinct({ pid: issues.parentIssueId })
      .from(issues)
      .where(and(eq(issues.workspaceId, workspaceId), isNotNull(issues.parentIssueId)))
      .all();
    for (const { pid } of parentIds) this.syncEpicStatus(pid);
  }

  /**
   * Marca como `pending` (aprovação) as épicas criadas neste turno sem decisão
   * de plano. Chamado no fim do run = "plano completo" — evita pedir aprovação
   * a cada sub-issue durante o streaming. Retorna quantas submeteu.
   */
  submitPlansCreatedSince(workspaceId: string, sinceIso: string, sessionId?: string): number {
    const all = this.listByWorkspace(workspaceId);
    let submitted = 0;
    for (const epic of all) {
      if (epic.createdAt < sinceIso) continue;
      if (epic.status === 'done' || epic.status === 'cancelled') continue;
      // Só TOP-LEVEL carrega o gate de aprovação (sub-issues herdam da épica).
      if (epic.parentIssueId) continue;
      const hasChildren = all.some((i) => i.parentIssueId === epic.id);
      // Precisa ser TRABALHO executável que vai mexer no código: ou é épica (tem
      // sub-issues), ou é uma issue ÚNICA com responsável. Antes só épicas com
      // filhos pediam aprovação → issue única executava sem o usuário aprovar.
      if (!hasChildren && !epic.assigneeAgentId) continue;
      const meta = (epic.metadata as { plan?: { status?: string } } | null) ?? null;
      if (meta?.plan?.status) continue; // já decidido/submetido
      this.update(epic.id, {
        metadata: { ...(epic.metadata ?? {}), plan: { status: 'pending', sessionId } },
      });
      submitted++;
    }
    return submitted;
  }

  /**
   * Conta issues criadas DURANTE um run de chat: escopadas pela sessão de origem
   * (`metadata.originSessionId`) E criadas a partir de `sinceIso` (início do run).
   * Escopar por sessão+run evita a corrida do diff workspace-wide (snapshot
   * before/after), em que issues criadas por OUTRO run concorrente eram contadas
   * como deste turno. Ambos os caminhos de criação (bloco e MCP `create_issue`)
   * gravam `originSessionId`.
   */
  countCreatedInSession(workspaceId: string, sessionId: string, sinceIso: string): number {
    const all = this.listByWorkspace(workspaceId);
    let count = 0;
    for (const issue of all) {
      if (issue.createdAt < sinceIso) continue;
      const meta = issue.metadata as { originSessionId?: string } | null;
      if (meta?.originSessionId === sessionId) count++;
    }
    return count;
  }

  create(input: {
    workspaceId: string;
    title: string;
    description?: string | null;
    status?: IssueStatus;
    priority?: IssuePriority;
    labels?: string[];
    assigneeAgentId?: string | null;
    reporterAgentId?: string | null;
    parentIssueId?: string | null;
    goalId?: string | null;
    dueDate?: string | null;
    metadata?: IssueMetadata | null;
  }): Issue {
    const db = getDatabase();
    // DEDUP: os dois caminhos de criação (bloco <orkestral:create-issue> e MCP
    // create_issue) podem disparar na MESMA resposta do agente. Se já existe uma
    // issue com o MESMO título (normalizado) E o MESMO pai no workspace criada
    // nos últimos 60s, devolve ela em vez de duplicar. Incluir o parentIssueId
    // evita colapsar sub-issues legítimas de ÉPICAS diferentes que (legitimamente)
    // compartilham um título genérico ("Backend", "Testes"). Janela curta → não
    // bloqueia recriação legítima depois.
    // NOTA: este scan roda FORA da transação abaixo — é best-effort (mesma resposta
    // do agente), NÃO uma serialização. Dois createFull concorrentes pro mesmo
    // título podem ambos passar o gate; a transação garante keys consistentes, não
    // dedup atômico.
    const wantTitle = input.title.trim().toLowerCase();
    const wantParentId = input.parentIssueId ?? null;
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const recentDupe = db
      .select()
      .from(issues)
      .where(and(eq(issues.workspaceId, input.workspaceId)))
      .all()
      .find(
        (r) =>
          r.title.trim().toLowerCase() === wantTitle &&
          (r.parentIssueId ?? null) === wantParentId &&
          r.createdAt >= cutoff,
      );
    if (recentDupe) {
      return rowToIssue(recentDupe);
    }
    const id = randomUUID();
    const now = nowIso();
    const parentId = input.parentIssueId ?? null;
    // Atomicidade: geração de issueKey/displayKey/childOrdinal + insert numa única
    // transação síncrona — ou a issue nasce com sua key consistente, ou nada muda
    // (sem counter avançado sem issue, sem keys repetidas sob concorrência). NENHUM
    // await/spawn aqui dentro (better-sqlite3 exige transaction síncrona e curta).
    // .immediate() → BEGIN IMMEDIATE: pega o write-lock LOGO de cara, antes dos
    // SELECT MAX(...) de nextDisplayKey/nextChildOrdinal. Garante a serialização
    // cross-process (app + core MCP no mesmo WAL) sem depender da ordem das
    // statements; sem isso o BEGIN DEFERRED só travaria na 1ª escrita e dois
    // escritores podiam ler o mesmo MAX e bater SQLITE_BUSY_SNAPSHOT.
    let row!: typeof issues.$inferSelect;
    db.transaction(
      () => {
        const issueKey = nextIssueKey(input.workspaceId);
        // Numeração humana: sub-issue ganha child_ordinal (posição entre irmãos) e
        // NÃO consome display_key; top-level ganha display_key sequencial. Mantém as
        // raízes contíguas e o issue_key interno intacto.
        const displayKey = parentId === null ? nextDisplayKey(input.workspaceId) : null;
        const childOrdinal = parentId === null ? null : nextChildOrdinal(parentId);
        row = {
          id,
          workspaceId: input.workspaceId,
          issueKey,
          displayKey,
          childOrdinal,
          title: input.title.trim(),
          description: input.description ?? null,
          status: (input.status ?? 'backlog') as IssueStatus,
          priority: (input.priority ?? 'medium') as IssuePriority,
          labels: input.labels ?? [],
          assigneeAgentId: input.assigneeAgentId ?? null,
          reporterAgentId: input.reporterAgentId ?? null,
          parentIssueId: input.parentIssueId ?? null,
          goalId: input.goalId ?? null,
          dueDate: input.dueDate ?? null,
          completedAt: null,
          metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
          createdAt: now,
          updatedAt: now,
        } as typeof issues.$inferSelect;
        db.insert(issues).values(row).run();
      },
      { behavior: 'immediate' },
    );
    // Épica (issue pai) é responsabilidade do CEO: assim que ela ganha um filho,
    // garante que fique atribuída ao orquestrador (antes nascia "não atribuído").
    if (parentId) this.syncParentEpic(parentId);
    return rowToIssue(row);
  }

  /**
   * Sincroniza a issue PAI (épica) a partir dos filhos. Idempotente:
   *  - atribui a épica ao orquestrador (CEO) se estiver sem dono — épicas são do
   *    CEO, antes ficavam "não atribuído";
   *  - quando TODOS os filhos estão em estado terminal (done/cancelled) e ao
   *    menos um está done, marca a épica como `done` (cascateia pra avós também,
   *    porque o update→done chama isto de novo no pai dela).
   */
  private syncParentEpic(parentId: string): void {
    const parent = this.get(parentId);
    if (!parent) return;

    if (!parent.assigneeAgentId) {
      const ceo = new AgentRepository()
        .listByWorkspace(parent.workspaceId)
        .find((a) => a.isOrchestrator);
      if (ceo) this.update(parent.id, { assigneeAgentId: ceo.id });
    }

    if (parent.status === 'cancelled') return;
    // Rollup unificado: a regra (todos terminais + ≥1 done) vive em syncEpicStatus.
    this.syncEpicStatus(parentId);
  }

  update(
    id: string,
    patch: {
      title?: string;
      description?: string | null;
      status?: IssueStatus;
      priority?: IssuePriority;
      labels?: string[];
      assigneeAgentId?: string | null;
      parentIssueId?: string | null;
      goalId?: string | null;
      dueDate?: string | null;
      metadata?: IssueMetadata | null;
    },
  ): Issue {
    const db = getDatabase();
    const now = nowIso();
    const setPayload: Record<string, unknown> = { updatedAt: now };
    if (patch.title !== undefined) setPayload.title = patch.title.trim();
    if (patch.description !== undefined) setPayload.description = patch.description;
    if (patch.priority !== undefined) setPayload.priority = patch.priority;
    if (patch.labels !== undefined) setPayload.labels = patch.labels;
    if (patch.assigneeAgentId !== undefined) setPayload.assigneeAgentId = patch.assigneeAgentId;
    if (patch.parentIssueId !== undefined) setPayload.parentIssueId = patch.parentIssueId;
    if (patch.goalId !== undefined) setPayload.goalId = patch.goalId;
    if (patch.dueDate !== undefined) setPayload.dueDate = patch.dueDate;
    if (patch.metadata !== undefined) {
      setPayload.metadataJson = patch.metadata ? JSON.stringify(patch.metadata) : null;
    }
    if (patch.status !== undefined) {
      setPayload.status = patch.status;
      // Marca completedAt quando vai pra done; limpa se sai de done.
      if (patch.status === 'done') setPayload.completedAt = now;
      else setPayload.completedAt = null;
    }
    db.update(issues).set(setPayload).where(eq(issues.id, id)).run();
    // Filho concluído/cancelado → reavalia a épica pai (conclui quando todos os
    // filhos terminam). Guard no status terminal evita custo/recursão à toa.
    if (patch.status === 'done' || patch.status === 'cancelled') {
      const updated = this.get(id);
      if (updated?.parentIssueId) this.syncParentEpic(updated.parentIssueId);
    }
    return this.get(id)!;
  }

  /** Resolve issue por chave numérica (BOR-12 → workspace + 12). */
  getByKey(workspaceId: string, issueKey: number): Issue | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(issues)
      .where(and(eq(issues.workspaceId, workspaceId), eq(issues.issueKey, issueKey)))
      .get();
    return row ? rowToIssue(row) : null;
  }

  // ---- Runs (execução por agente) ----
  startRun(input: {
    issueId: string;
    agentId: string | null;
    status?: IssueRun['status'];
    adapterType?: string | null;
  }): IssueRun {
    const db = getDatabase();
    const row = {
      id: randomUUID(),
      issueId: input.issueId,
      agentId: input.agentId,
      // Persiste 'queued' enquanto o run espera janela segura na fila; o serviço
      // promove pra 'running' quando de fato começa (markRunRunning).
      status: (input.status ?? 'queued') as IssueRun['status'],
      startedAt: nowIso(),
      finishedAt: null,
      errorMessage: null,
      outputSummary: null,
      exitCode: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      toolCallCount: null,
      adapterType: input.adapterType ?? null,
      exitReason: null,
    };
    db.insert(issueRuns).values(row).run();
    return rowToRun(row as typeof issueRuns.$inferSelect);
  }

  /** Promove um run da fila ('queued') para 'running' quando ele de fato inicia. */
  markRunRunning(runId: string, adapterType?: string | null): void {
    const db = getDatabase();
    const set: Record<string, unknown> = { status: 'running' };
    if (adapterType !== undefined) set.adapterType = adapterType;
    db.update(issueRuns).set(set).where(eq(issueRuns.id, runId)).run();
  }

  finishRun(runId: string, patch: FinishRunPatch): void {
    const db = getDatabase();
    const set: Record<string, unknown> = {
      status: patch.status,
      finishedAt: nowIso(),
      errorMessage: patch.errorMessage ?? null,
      outputSummary: patch.outputSummary ?? null,
      exitCode: patch.exitCode ?? null,
    };
    if (patch.tokensIn !== undefined) set.tokensIn = patch.tokensIn;
    if (patch.tokensOut !== undefined) set.tokensOut = patch.tokensOut;
    if (patch.costUsd !== undefined) set.costUsd = patch.costUsd;
    if (patch.toolCallCount !== undefined) set.toolCallCount = patch.toolCallCount;
    if (patch.adapterType !== undefined) set.adapterType = patch.adapterType;
    if (patch.exitReason !== undefined) {
      // NÃO apaga a marca 'escalated_to_premium': o CLI premium roda no MESMO runId e
      // seu finish não pode zerar o exit_reason de que a contagem de escalações depende.
      const current = db
        .select({ exitReason: issueRuns.exitReason })
        .from(issueRuns)
        .where(eq(issueRuns.id, runId))
        .get();
      const wouldEraseEscalation =
        current?.exitReason === 'escalated_to_premium' &&
        patch.exitReason !== 'escalated_to_premium';
      if (!wouldEraseEscalation) set.exitReason = patch.exitReason;
    }
    db.update(issueRuns).set(set).where(eq(issueRuns.id, runId)).run();
  }

  /**
   * Aplica APENAS o status (+ completedAt) numa issue, sem o rollup de épica do
   * `update()`. Usado dentro de `finishRunAndSetStatus` pra não reentrar
   * `syncParentEpic` (writes recursivos) dentro da transação síncrona.
   */
  private applyStatusOnly(id: string, status: IssueStatus): void {
    const db = getDatabase();
    const now = nowIso();
    db.update(issues)
      .set({
        status,
        updatedAt: now,
        // Marca completedAt quando vai pra done; limpa se sai de done (mesma
        // lógica do update() completo).
        completedAt: status === 'done' ? now : null,
      })
      .where(eq(issues.id, id))
      .run();
  }

  /**
   * Aplica o fim do run E a transição de status da issue numa ÚNICA transação
   * síncrona — torna atômica a invariante "run terminou ⇔ issue transicionou"
   * (antes eram duas statements; um crash/SQLITE_BUSY no meio corrompia o board).
   * NENHUM await/spawn aqui dentro. O rollup de épica (syncParentEpic) fica FORA:
   * os callers já reavaliam a épica logo após (routeReviewOrFinish/maybeReport…).
   */
  finishRunAndSetStatus(
    runId: string,
    runPatch: FinishRunPatch,
    issueId: string,
    statusPatch: { status: IssueStatus },
  ): Issue {
    const db = getDatabase();
    db.transaction(() => {
      this.finishRun(runId, runPatch);
      this.applyStatusOnly(issueId, statusPatch.status);
    });
    return this.get(issueId)!;
  }

  listRuns(issueId: string): IssueRun[] {
    const db = getDatabase();
    return db
      .select()
      .from(issueRuns)
      .where(eq(issueRuns.issueId, issueId))
      .orderBy(desc(issueRuns.startedAt))
      .all()
      .map(rowToRun);
  }

  listRunningRunsByWorkspace(workspaceId: string): Array<{ run: IssueRun; issue: Issue }> {
    const db = getDatabase();
    return db
      .select()
      .from(issueRuns)
      .innerJoin(issues, eq(issueRuns.issueId, issues.id))
      .where(and(eq(issues.workspaceId, workspaceId), eq(issueRuns.status, 'running')))
      .orderBy(desc(issueRuns.startedAt))
      .all()
      .map((row) => ({
        run: rowToRun(row.issue_runs),
        issue: rowToIssue(row.issues),
      }));
  }

  /**
   * Runs ATIVOS (queued OU running) de um workspace. Runs em 'queued' agora são
   * persistidos (esperando janela na fila) — após um crash ficam órfãos e o boot
   * recovery precisa varrê-los também, não só os 'running'.
   */
  listActiveRunsByWorkspace(workspaceId: string): Array<{ run: IssueRun; issue: Issue }> {
    const db = getDatabase();
    return db
      .select()
      .from(issueRuns)
      .innerJoin(issues, eq(issueRuns.issueId, issues.id))
      .where(
        and(eq(issues.workspaceId, workspaceId), inArray(issueRuns.status, ['queued', 'running'])),
      )
      .orderBy(desc(issueRuns.startedAt))
      .all()
      .map((row) => ({
        run: rowToRun(row.issue_runs),
        issue: rowToIssue(row.issues),
      }));
  }

  /** Todas as runs de um workspace (join issue_runs → issues), recentes primeiro.
   *  Usado por diagnostics + métricas de observabilidade. */
  listRunsByWorkspace(workspaceId: string, limit = 500): IssueRun[] {
    const db = getDatabase();
    return db
      .select()
      .from(issueRuns)
      .innerJoin(issues, eq(issueRuns.issueId, issues.id))
      .where(eq(issues.workspaceId, workspaceId))
      .orderBy(desc(issueRuns.startedAt))
      .limit(limit)
      .all()
      .map((r) => rowToRun(r.issue_runs));
  }

  /** Runs de issue executadas por um agente (pra atividade do agente). */
  listRunsByAgent(agentId: string, limit = 20): IssueRun[] {
    const db = getDatabase();
    return db
      .select()
      .from(issueRuns)
      .where(eq(issueRuns.agentId, agentId))
      .orderBy(desc(issueRuns.startedAt))
      .limit(limit)
      .all()
      .map(rowToRun);
  }

  delete(id: string): void {
    const db = getDatabase();
    db.delete(issues).where(eq(issues.id, id)).run();
  }

  // ----- Comments -----

  listComments(issueId: string): IssueComment[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt))
      .all();
    return rows.map(rowToComment);
  }

  addComment(input: {
    issueId: string;
    body: string;
    authorAgentId?: string | null;
    authorKind?: 'user' | 'agent' | 'system';
    attachments?: IssueAttachment[];
  }): IssueComment {
    const db = getDatabase();
    const id = randomUUID();
    const now = nowIso();
    const row = {
      id,
      issueId: input.issueId,
      authorAgentId: input.authorAgentId ?? null,
      authorKind: input.authorKind ?? 'user',
      body: input.body,
      attachments: input.attachments ?? [],
      createdAt: now,
    };
    db.insert(issueComments).values(row).run();
    // Atualiza updatedAt da issue pra refletir atividade
    db.update(issues).set({ updatedAt: now }).where(eq(issues.id, input.issueId)).run();
    return rowToComment(row as typeof issueComments.$inferSelect);
  }

  deleteComment(id: string): void {
    const db = getDatabase();
    db.delete(issueComments).where(eq(issueComments.id, id)).run();
  }

  // ----- Stats agregadas pro Dashboard / Agent dashboard -----

  countsByStatus(workspaceId: string): Record<IssueStatus, number> {
    const db = getDatabase();
    const rows = db
      .select({
        status: issues.status,
        count: sql<number>`count(*)`,
      })
      .from(issues)
      .where(eq(issues.workspaceId, workspaceId))
      .groupBy(issues.status)
      .all();
    const result: Record<IssueStatus, number> = {
      backlog: 0,
      todo: 0,
      in_progress: 0,
      in_review: 0,
      blocked: 0,
      done: 0,
      cancelled: 0,
    };
    for (const r of rows) {
      result[r.status as IssueStatus] = Number(r.count) || 0;
    }
    return result;
  }
}
