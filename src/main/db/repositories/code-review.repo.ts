import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ne, notInArray } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { codeReviews, codeReviewComments } from '../schema';
import type {
  CodeReview,
  CodeReviewComment,
  CodeReviewCommentKind,
  CodeReviewEffort,
  CodeReviewFileChange,
  CodeReviewLinkedPr,
  CodeReviewRecommendation,
  CodeReviewSeverity,
  CodeReviewStatus,
  CodeReviewWalkthroughItem,
} from '../../../shared/types';

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToReview(row: typeof codeReviews.$inferSelect): CodeReview {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    repoFullName: row.repoFullName,
    prNumber: row.prNumber,
    prTitle: row.prTitle,
    prAuthor: row.prAuthor,
    headRef: row.headRef,
    baseRef: row.baseRef,
    headSha: row.headSha,
    htmlUrl: row.htmlUrl,
    reviewerAgentId: row.reviewerAgentId,
    status: row.status as CodeReviewStatus,
    summary: row.summary,
    riskLevel: row.riskLevel,
    errorMessage: row.errorMessage,
    totalComments: row.totalComments,
    bugCount: row.bugCount,
    suggestionCount: row.suggestionCount,
    securityCount: row.securityCount,
    styleCount: row.styleCount,
    performanceCount: row.performanceCount,
    questionCount: row.questionCount,
    postedToGithubAt: row.postedToGithubAt,
    githubReviewId: row.githubReviewId,
    rating: row.rating ?? null,
    effort: (row.effort as CodeReviewEffort | null) ?? null,
    recommendation: (row.recommendation as CodeReviewRecommendation | null) ?? null,
    testsAssessment: row.testsAssessment ?? null,
    walkthrough: parseJsonArray<CodeReviewWalkthroughItem>(row.walkthroughJson),
    filesChanged: parseJsonArray<CodeReviewFileChange>(row.filesChangedJson),
    highlights: parseJsonArray<string>(row.highlightsJson),
    concerns: parseJsonArray<string>(row.concernsJson),
    linkedPrs: parseJsonArray<CodeReviewLinkedPr>(row.linkedPrsJson),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

function rowToComment(row: typeof codeReviewComments.$inferSelect): CodeReviewComment {
  return {
    id: row.id,
    reviewId: row.reviewId,
    filePath: row.filePath,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    kind: row.kind as CodeReviewCommentKind,
    severity: row.severity as CodeReviewSeverity,
    title: row.title ?? null,
    message: row.message,
    suggestion: row.suggestion,
    diffHunk: row.diffHunk ?? null,
    codeContext: row.codeContext ?? null,
    resolution: row.resolution,
    githubCommentId: row.githubCommentId,
    createdAt: row.createdAt,
  };
}

export class CodeReviewRepository {
  /** Cria a review em status='analyzing'. */
  start(input: {
    workspaceId: string;
    repoFullName: string;
    prNumber: number;
    prTitle: string;
    prAuthor?: string | null;
    headRef?: string | null;
    baseRef?: string | null;
    headSha?: string | null;
    htmlUrl: string;
    reviewerAgentId?: string | null;
    linkedPrs?: CodeReviewLinkedPr[];
  }): CodeReview {
    const db = getDatabase();
    const id = randomUUID();
    const now = nowIso();
    const row = {
      id,
      workspaceId: input.workspaceId,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      prTitle: input.prTitle,
      prAuthor: input.prAuthor ?? null,
      headRef: input.headRef ?? null,
      baseRef: input.baseRef ?? null,
      headSha: input.headSha ?? null,
      htmlUrl: input.htmlUrl,
      reviewerAgentId: input.reviewerAgentId ?? null,
      status: 'analyzing' as const,
      summary: null,
      riskLevel: null,
      errorMessage: null,
      totalComments: 0,
      bugCount: 0,
      suggestionCount: 0,
      securityCount: 0,
      styleCount: 0,
      performanceCount: 0,
      questionCount: 0,
      postedToGithubAt: null,
      githubReviewId: null,
      rating: null,
      effort: null,
      recommendation: null,
      testsAssessment: null,
      walkthroughJson: null,
      filesChangedJson: null,
      highlightsJson: null,
      concernsJson: null,
      linkedPrsJson: input.linkedPrs?.length ? JSON.stringify(input.linkedPrs) : null,
      startedAt: now,
      finishedAt: null,
      createdAt: now,
    };
    db.insert(codeReviews).values(row).run();
    return rowToReview(row as typeof codeReviews.$inferSelect);
  }

  finishSuccess(
    id: string,
    input: {
      summary: string;
      riskLevel: string;
      rating?: number | null;
      effort?: CodeReviewEffort | null;
      recommendation?: CodeReviewRecommendation | null;
      testsAssessment?: string | null;
      walkthrough?: CodeReviewWalkthroughItem[];
      filesChanged?: CodeReviewFileChange[];
      highlights?: string[];
      concerns?: string[];
    },
    comments: Array<{
      filePath: string;
      lineStart?: number | null;
      lineEnd?: number | null;
      kind: CodeReviewCommentKind;
      severity: CodeReviewSeverity;
      title?: string | null;
      message: string;
      suggestion?: string | null;
      diffHunk?: string | null;
      codeContext?: string | null;
    }>,
  ): CodeReview {
    const db = getDatabase();
    const now = nowIso();
    const counters = {
      bug: 0,
      suggestion: 0,
      security: 0,
      style: 0,
      performance: 0,
      question: 0,
    };
    const commentRows = comments.map((c) => {
      counters[c.kind] = (counters[c.kind] ?? 0) + 1;
      return {
        id: randomUUID(),
        reviewId: id,
        filePath: c.filePath,
        lineStart: c.lineStart ?? null,
        lineEnd: c.lineEnd ?? null,
        kind: c.kind,
        severity: c.severity,
        title: c.title ?? null,
        message: c.message,
        suggestion: c.suggestion ?? null,
        diffHunk: c.diffHunk ?? null,
        codeContext: c.codeContext ?? null,
        resolution: 'pending' as const,
        githubCommentId: null,
        createdAt: now,
      };
    });
    if (commentRows.length > 0) {
      db.insert(codeReviewComments).values(commentRows).run();
    }
    db.update(codeReviews)
      .set({
        status: 'completed',
        summary: input.summary,
        riskLevel: input.riskLevel,
        rating: input.rating ?? null,
        effort: input.effort ?? null,
        recommendation: input.recommendation ?? null,
        testsAssessment: input.testsAssessment ?? null,
        walkthroughJson: input.walkthrough ? JSON.stringify(input.walkthrough) : null,
        filesChangedJson: input.filesChanged ? JSON.stringify(input.filesChanged) : null,
        highlightsJson: input.highlights ? JSON.stringify(input.highlights) : null,
        concernsJson: input.concerns ? JSON.stringify(input.concerns) : null,
        totalComments: commentRows.length,
        bugCount: counters.bug,
        suggestionCount: counters.suggestion,
        securityCount: counters.security,
        styleCount: counters.style,
        performanceCount: counters.performance,
        questionCount: counters.question,
        finishedAt: now,
      })
      // Só escreve 'completed' se a review NÃO está num estado terminal (cancelada pelo
      // usuário) — UPDATE guardado pelo DB (atômico, sem TOCTOU) pra um finishSuccess em voo
      // não ressuscitar uma review cancelada.
      .where(and(eq(codeReviews.id, id), notInArray(codeReviews.status, ['cancelled', 'failed'])))
      .run();
    return this.get(id)!;
  }

  /**
   * Atualiza metadados do PR (titulo/author/refs/sha) — útil quando a review
   * foi criada com placeholders antes do fetch terminar.
   */
  updateMetadata(
    id: string,
    patch: {
      prTitle?: string;
      prAuthor?: string | null;
      headRef?: string | null;
      baseRef?: string | null;
      headSha?: string | null;
      htmlUrl?: string;
    },
  ): void {
    const db = getDatabase();
    const set: Record<string, unknown> = {};
    if (patch.prTitle !== undefined) set.prTitle = patch.prTitle;
    if (patch.prAuthor !== undefined) set.prAuthor = patch.prAuthor;
    if (patch.headRef !== undefined) set.headRef = patch.headRef;
    if (patch.baseRef !== undefined) set.baseRef = patch.baseRef;
    if (patch.headSha !== undefined) set.headSha = patch.headSha;
    if (patch.htmlUrl !== undefined) set.htmlUrl = patch.htmlUrl;
    if (Object.keys(set).length === 0) return;

    // Re-review do mesmo commit: remove qualquer review anterior do mesmo
    // PR+head_sha antes de gravar o sha aqui — senão o UPDATE viola o índice
    // único (workspace, repo, pr, head_sha). Comments somem por cascade.
    // Delete + update rodam numa transaction pra serem atômicos: nenhuma
    // duplicata escapa entre os dois statements (o que reintroduziria o erro
    // de UNIQUE constraint no retry/reanalyze).
    if (patch.headSha != null) {
      const headSha = patch.headSha;
      const row = db
        .select({
          workspaceId: codeReviews.workspaceId,
          repoFullName: codeReviews.repoFullName,
          prNumber: codeReviews.prNumber,
        })
        .from(codeReviews)
        .where(eq(codeReviews.id, id))
        .get();
      if (row) {
        db.transaction((tx) => {
          tx.delete(codeReviews)
            .where(
              and(
                eq(codeReviews.workspaceId, row.workspaceId),
                eq(codeReviews.repoFullName, row.repoFullName),
                eq(codeReviews.prNumber, row.prNumber),
                eq(codeReviews.headSha, headSha),
                ne(codeReviews.id, id),
              ),
            )
            .run();
          tx.update(codeReviews).set(set).where(eq(codeReviews.id, id)).run();
        });
        return;
      }
    }

    db.update(codeReviews).set(set).where(eq(codeReviews.id, id)).run();
  }

  fail(id: string, error: string): CodeReview {
    const db = getDatabase();
    db.update(codeReviews)
      .set({
        status: 'failed',
        errorMessage: error,
        finishedAt: nowIso(),
      })
      // Não sobrescreve uma review já concluída/cancelada com um erro tardio.
      .where(
        and(eq(codeReviews.id, id), notInArray(codeReviews.status, ['completed', 'cancelled'])),
      )
      .run();
    return this.get(id)!;
  }

  get(id: string): CodeReview | null {
    const db = getDatabase();
    const row = db.select().from(codeReviews).where(eq(codeReviews.id, id)).get();
    return row ? rowToReview(row) : null;
  }

  listByWorkspace(workspaceId: string, limit = 50): CodeReview[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(codeReviews)
      .where(eq(codeReviews.workspaceId, workspaceId))
      .orderBy(desc(codeReviews.startedAt))
      .limit(limit)
      .all();
    return rows.map(rowToReview);
  }

  listByReviewer(agentId: string, limit = 50): CodeReview[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(codeReviews)
      .where(eq(codeReviews.reviewerAgentId, agentId))
      .orderBy(desc(codeReviews.startedAt))
      .limit(limit)
      .all();
    return rows.map(rowToReview);
  }

  /** Pega a review mais recente desse PR (qualquer status). */
  getLatestForPr(workspaceId: string, repoFullName: string, prNumber: number): CodeReview | null {
    const db = getDatabase();
    const row = db
      .select()
      .from(codeReviews)
      .where(
        and(
          eq(codeReviews.workspaceId, workspaceId),
          eq(codeReviews.repoFullName, repoFullName),
          eq(codeReviews.prNumber, prNumber),
        ),
      )
      .orderBy(desc(codeReviews.startedAt))
      .limit(1)
      .get();
    return row ? rowToReview(row) : null;
  }

  listComments(reviewId: string): CodeReviewComment[] {
    const db = getDatabase();
    const rows = db
      .select()
      .from(codeReviewComments)
      .where(eq(codeReviewComments.reviewId, reviewId))
      .orderBy(asc(codeReviewComments.filePath), asc(codeReviewComments.lineStart))
      .all();
    return rows.map(rowToComment);
  }

  updateCommentResolution(commentId: string, resolution: 'pending' | 'resolved' | 'ignored'): void {
    const db = getDatabase();
    db.update(codeReviewComments)
      .set({ resolution })
      .where(eq(codeReviewComments.id, commentId))
      .run();
  }

  markPostedToGithub(reviewId: string, githubReviewId: string | null): void {
    const db = getDatabase();
    db.update(codeReviews)
      .set({ postedToGithubAt: nowIso(), githubReviewId })
      .where(eq(codeReviews.id, reviewId))
      .run();
  }

  delete(id: string): void {
    const db = getDatabase();
    db.delete(codeReviews).where(eq(codeReviews.id, id)).run();
  }
}
