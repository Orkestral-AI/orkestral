/**
 * RAG-DE-EDITS (HORIZON Fase 4 — reativado em 2026-07-04): exemplos de lazy-edits
 * aceitos no workspace alimentam o few-shot do fast-apply local (`edit_file` tier 2)
 * — o merge aprende o estilo REAL do repo sem treinar nem enviar nada pra fora.
 * Ciclo de vida: `candidate` (aplicado, aguardando o gate de qualidade) →
 * `accepted` (a issue fechou VERIFICADA: vira exemplo de verdade) | `rejected`.
 * O CÓDIGO FICA LOCAL — a tabela vive no SQLite do app, nunca vai pra Cloud.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { forgeEditExamples } from '../schema';

interface ForgeEditExample {
  file: string;
  symbol: string | null;
  instruction: string;
  acceptedEdit: string;
}

/** Quantos exemplos aceitos recentes entram no ranking em memória. */
const RETRIEVE_SCAN_LIMIT = 200;
/** Teto por exemplo gravado — edit gigante não vira few-shot útil. */
const EXAMPLE_MAX_CHARS = 4_000;

function nowIso(): string {
  return new Date().toISOString();
}

function tokensOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

function extOf(file: string): string {
  const idx = file.lastIndexOf('.');
  return idx >= 0 ? file.slice(idx + 1).toLowerCase() : '';
}

class ForgeEditExamplesRepository {
  /**
   * Top-K exemplos ACEITOS mais relevantes pra um novo edit: mesma extensão de
   * arquivo pesa mais (estilo por linguagem), mesmo diretório e overlap lexical
   * da instrução desempatam. Ranking simples em memória sobre os aceitos recentes.
   */
  retrieveTopK(
    workspaceId: string,
    query: { instruction: string; file: string },
    k: number,
  ): ForgeEditExample[] {
    if (k <= 0) return [];
    try {
      const db = getDatabase();
      const rows = db
        .select()
        .from(forgeEditExamples)
        .where(
          and(
            eq(forgeEditExamples.workspaceId, workspaceId),
            eq(forgeEditExamples.status, 'accepted'),
          ),
        )
        .orderBy(desc(forgeEditExamples.updatedAt))
        .limit(RETRIEVE_SCAN_LIMIT)
        .all();
      if (rows.length === 0) return [];
      const qTokens = tokensOf(query.instruction);
      const qExt = extOf(query.file);
      const qDir = query.file.split('/').slice(0, -1).join('/');
      const scored = rows.map((r) => {
        let score = 0;
        if (qExt && extOf(r.file) === qExt) score += 3;
        if (qDir && r.file.startsWith(`${qDir}/`)) score += 2;
        if (r.file === query.file) score += 2;
        for (const t of tokensOf(r.instruction)) if (qTokens.has(t)) score += 1;
        return { r, score };
      });
      return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map(({ r }) => ({
          file: r.file,
          symbol: r.symbol,
          instruction: r.instruction,
          acceptedEdit: r.acceptedEdit,
        }));
    } catch {
      return []; // retrieval é otimização — nunca derruba o edit
    }
  }

  /** Grava um exemplo CANDIDATO (edit aplicado, aguardando o gate de qualidade). */
  record(input: {
    workspaceId: string;
    runId?: string | null;
    issueId?: string | null;
    file: string;
    symbol?: string | null;
    instruction: string;
    anchorExcerpt?: string | null;
    acceptedEdit: string;
    editFormat?: string;
  }): void {
    if (!input.acceptedEdit.trim() || input.acceptedEdit.length > EXAMPLE_MAX_CHARS) return;
    try {
      const db = getDatabase();
      const now = nowIso();
      db.insert(forgeEditExamples)
        .values({
          id: randomUUID(),
          workspaceId: input.workspaceId,
          runId: input.runId ?? null,
          issueId: input.issueId ?? null,
          file: input.file,
          symbol: input.symbol ?? null,
          instruction: input.instruction.slice(0, 500),
          anchorExcerpt: input.anchorExcerpt ?? null,
          acceptedEdit: input.acceptedEdit,
          editFormat: input.editFormat ?? 'lazy',
          status: 'candidate',
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (err) {
      console.warn('[forge-examples] record falhou:', err);
    }
  }

  /** Review aprovou o run → os candidatos dele viram exemplos ACEITOS. */
  promoteByRun(runId: string): void {
    this.settleByRun(runId, 'accepted');
  }

  /** Review reprovou → descarta (não ensina o merge com edit ruim). */
  rejectByRun(runId: string): void {
    this.settleByRun(runId, 'rejected');
  }

  private settleByRun(runId: string, status: 'accepted' | 'rejected'): void {
    try {
      const db = getDatabase();
      db.update(forgeEditExamples)
        .set({ status, updatedAt: nowIso() })
        .where(and(eq(forgeEditExamples.runId, runId), eq(forgeEditExamples.status, 'candidate')))
        .run();
    } catch (err) {
      console.warn('[forge-examples] settle falhou:', err);
    }
  }
}

export const forgeEditExamplesRepo = new ForgeEditExamplesRepository();
