/**
 * Fast Apply do Orkestral como FERRAMENTA de agente (MCP `edit_file`): o modelo
 * premium emite um snippet LAZY (só o código que muda, com marcadores
 * `// ... existing code ...`) e o app mescla no arquivo — 1º tier determinístico
 * (morph, custo zero), 2º tier o modelo local DEDICADO de fast-apply
 * (FastApply-1.5B) quando a âncora não casa. Economiza os tokens de saída do
 * premium (não precisa reproduzir o trecho antigo exato) e é INDEPENDENTE do
 * kill-switch do Forge: o modelo de merge não conversa nem gera código novo,
 * só mescla o que o premium já escreveu.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getSmartExecConfig } from './config';
import { applyLazyEdit, applyWholeFile, isInsideRepo } from './diff';
import { generateLocalFastApply } from './local-patcher';
import { droppedTopLevelImports, hasLazyMarkers } from './morph';
import { getFastApplyModelPath } from '../model-download-service';
import { forgeEditExamplesRepo } from '../../db/repositories/forge-edit-examples.repo';

/** Mesmo teto do orchestrator: a saída do merge precisa caber em maxOutputTokens. */
const FAST_APPLY_MAX_CHARS = 12_000;

export interface FastApplyToolResult {
  applied: boolean;
  /** true quando o arquivo foi criado (não existia). */
  created?: boolean;
  changedLines?: number;
  /** Qual tier gravou: merge por âncora, modelo fast-apply ou criação direta. */
  strategy?: 'deterministic' | 'fast-apply-model' | 'create';
  error?: string;
}

/**
 * Aplica um lazy-edit em UM arquivo do repo. Nunca lança: devolve
 * `{applied:false, error}` pra o agente cair no editor nativo dele.
 */
export async function fastApplyEditFile(input: {
  repoPath: string;
  relPath: string;
  codeEdit: string;
  instructions?: string;
  /** Contexto do caller (MCP): habilita o RAG-de-edits (HORIZON Fase 4). */
  workspaceId?: string;
  runId?: string | null;
  issueId?: string | null;
}): Promise<FastApplyToolResult> {
  const { repoPath, relPath, codeEdit } = input;
  if (!codeEdit.trim()) return { applied: false, error: 'code_edit vazio' };
  if (!isInsideRepo(repoPath, relPath)) {
    return { applied: false, error: 'caminho fora do repositório rejeitado' };
  }
  const abs = join(resolve(repoPath), relPath);

  // RAG-DE-EDITS: cada edit aplicado com sucesso vira exemplo CANDIDATO — quando a
  // issue fechar VERIFICADA, promove pra aceito e alimenta o few-shot dos merges
  // futuros (estilo real do repo). Best-effort, nunca bloqueia o edit.
  const recordCandidate = (): void => {
    if (!input.workspaceId) return;
    forgeEditExamplesRepo.record({
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      issueId: input.issueId ?? null,
      file: relPath,
      instruction: input.instructions ?? 'Merge the update into the file',
      acceptedEdit: codeEdit,
      editFormat: 'lazy',
    });
  };

  // Arquivo NOVO: o snippet É o conteúdo completo; marcadores lazy não têm o que expandir.
  if (!existsSync(abs)) {
    if (hasLazyMarkers(codeEdit)) {
      return {
        applied: false,
        error: `${relPath} não existe — pra criar o arquivo, envie o conteúdo COMPLETO sem marcadores "existing code"`,
      };
    }
    const created = applyWholeFile(repoPath, relPath, codeEdit);
    return created.applied
      ? { applied: true, created: true, changedLines: created.changedLines, strategy: 'create' }
      : { applied: false, error: created.error };
  }

  // Tier 1 — merge determinístico por âncora (morph): sem inferência, custo zero.
  const det = applyLazyEdit(repoPath, relPath, codeEdit);
  if (det.applied) {
    recordCandidate();
    return { applied: true, changedLines: det.changedLines, strategy: 'deterministic' };
  }

  // Tier 2 — modelo local de fast-apply mescla o snippet no arquivo inteiro.
  // Só arquivo pequeno, e só se o GGUF dedicado já está em disco (sem download inline).
  const before = readFileSync(abs, 'utf-8');
  const faPath = getFastApplyModelPath();
  if (faPath && before.length <= FAST_APPLY_MAX_CHARS) {
    try {
      const cfg = getSmartExecConfig();
      // Few-shot do RAG-de-edits: exemplos ACEITOS do mesmo workspace guiam o
      // merge no estilo real do repo (o local-patcher já orça o espaço deles).
      const examples = input.workspaceId
        ? forgeEditExamplesRepo.retrieveTopK(
            input.workspaceId,
            { instruction: input.instructions ?? '', file: relPath },
            3,
          )
        : [];
      const merged = await generateLocalFastApply(
        cfg,
        {
          taskId: `edit-file:${relPath}`,
          filePath: relPath,
          instruction: input.instructions ?? 'Merge the update into the file',
          fileContent: before,
          examples,
          constraints: {
            maxChangedLines: Number.MAX_SAFE_INTEGER,
            allowedFiles: [relPath],
            forbiddenFiles: [],
            allowNewFiles: false,
            allowPublicApiChanges: true,
            allowArchitectureChanges: true,
          },
        },
        codeEdit,
        faPath,
      );
      if (merged.kind === 'edit' && merged.update !== before) {
        // Mesmas guardas do orchestrator: nunca gravar deleção em massa nem import-drop.
        const origN = before.split('\n').length;
        const newN = merged.update.split('\n').length;
        const shrankTooMuch = origN > 8 && newN < origN * 0.6;
        if (!shrankTooMuch && !droppedTopLevelImports(before, merged.update)) {
          const applied = applyWholeFile(repoPath, relPath, merged.update);
          if (applied.applied && applied.changedLines > 0) {
            recordCandidate();
            return {
              applied: true,
              changedLines: applied.changedLines,
              strategy: 'fast-apply-model',
            };
          }
        }
      }
    } catch {
      /* modelo indisponível/timeout — cai no erro determinístico abaixo */
    }
  }

  return {
    applied: false,
    error: det.error
      ? `merge por âncora falhou (${det.error}) — inclua mais linhas de contexto original em volta da mudança, ou use seu editor nativo`
      : 'merge falhou — use seu editor nativo',
  };
}
