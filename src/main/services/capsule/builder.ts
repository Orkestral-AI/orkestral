/**
 * Builder DETERMINÍSTICO da Cápsula (OEP Fase 0 — sem premium). Monta a Cápsula a partir
 * de sinais que o pipeline JÁ produz (classificação, metadata.done, pitfall store) +
 * asserts/escopo derivados. A crítica adversarial é a lei aqui: o premium é o elo fraco,
 * então NÃO dependemos dele pra montar estrutura — o builder produz uma Cápsula útil
 * antes de qualquer token premium. O premium só ELEVA (Fase 1) os campos de texto livre.
 */
import { randomUUID, createHash } from 'node:crypto';
import type { Issue, TaskClassification } from '../../../shared/types';
import type { TaskCapsule, CapsuleTarget, Pitfall } from '../../../shared/types/capsule';
import { OEP_VERSION } from '../../../shared/types/capsule';
import { deriveAsserts } from './contract';
import { forgePitfallsRepo } from '../../db/repositories/forge-pitfalls.repo';

/** Teto default de linhas alteradas por arquivo (espelha o threshold do smart-exec). */
const DEFAULT_MAX_CHANGED_LINES = 200;

/** Termos canônicos pra ranquear exemplares/pitfalls (tokenização simples e estável). */
export function deriveCapsuleKeywords(issue: Issue): string[] {
  const text = `${issue.title} ${issue.description ?? ''}`.toLowerCase();
  const stop = new Set([
    'the',
    'a',
    'an',
    'de',
    'da',
    'do',
    'em',
    'para',
    'com',
    'que',
    'os',
    'as',
    'um',
    'uma',
    'and',
    'or',
    'to',
    'in',
    'on',
    'of',
    'no',
    'na',
    'e',
    'o',
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of text.split(/[^a-z0-9_$]+/)) {
    if (w.length < 3 || stop.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Monta a Cápsula de uma issue. `done` vem de metadata.done. Targets vêm da
 * classificação (edit = affectedFiles, create = createFiles). Pitfalls vêm do RAG de
 * erros. Asserts e escopo são derivados deterministicamente.
 */
export function buildCapsule(issue: Issue, cls: TaskClassification): TaskCapsule {
  const done = (issue.metadata as { done?: string } | null)?.done?.trim() ?? '';
  const keywords = deriveCapsuleKeywords(issue);
  const goal = (issue.title || done || 'tarefa').slice(0, 140);

  const editTargets: CapsuleTarget[] = (cls.affectedFiles ?? []).map((file, i) => ({
    taskId: `task_${String(i + 1).padStart(3, '0')}`,
    file,
    op: 'edit' as const,
    region: null,
    delta: goal,
    maxChangedLines: DEFAULT_MAX_CHANGED_LINES,
  }));
  const createTargets: CapsuleTarget[] = (cls.createFiles ?? []).map((file, i) => ({
    taskId: `create_${String(i + 1).padStart(3, '0')}`,
    file,
    op: 'create' as const,
    region: null,
    delta: goal,
    maxChangedLines: DEFAULT_MAX_CHANGED_LINES,
  }));
  const targets = [...editTargets, ...createTargets];

  // Asserts: união dos asserts derivados de cada alvo (guard-rails anti-regressão).
  const asserts = targets.flatMap((t) => deriveAsserts(t, done));

  // Pitfalls: o que JÁ falhou neste workspace pra tarefas parecidas (RAG de erros).
  const pitfalls: Pitfall[] = forgePitfallsRepo.retrieveTopK(
    issue.workspaceId,
    { keywords, file: targets[0]?.file ?? null },
    2,
  );

  const stableHash = createHash('sha256')
    .update(JSON.stringify({ goal, files: targets.map((t) => t.file), done }))
    .digest('hex')
    .slice(0, 16);

  return {
    v: OEP_VERSION,
    capsuleId: randomUUID(),
    issueId: issue.id,
    workspaceId: issue.workspaceId,
    goal,
    keywords,
    targets,
    scope: {
      lockedPaths: [],
      allowNewFiles: createTargets.length > 0,
      touchBudgetFiles: Math.max(1, targets.length),
    },
    contract: { done, asserts },
    // TODO(Fase 1): destilar `patterns` do kb-learning e ligar `exemplarRefs` ao
    // forgeEditExamplesRepo. Hoje vazios — os exemplares JÁ chegam ao Forge pelo caminho
    // legado (renderExamplesBlock no local-patcher), então não é teatro; só não passam
    // pela cápsula ainda. O RAG de pitfalls (abaixo) é o que esta cápsula já entrega.
    patterns: [],
    pitfalls,
    exemplarRefs: [],
    provenance: {
      compiledBy: 'deterministic-builder',
      compiledAt: new Date().toISOString(),
      capsuleHash: stableHash,
      ledger: [],
    },
  };
}
