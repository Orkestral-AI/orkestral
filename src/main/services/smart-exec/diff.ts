/**
 * Aplicação reversível de reescritas de arquivo (com snapshot) → rollback.
 * Quem aplica a mudança é SEMPRE o app, nunca o modelo. O modelo só produz o
 * conteúdo/edits; o merge é determinístico (morph/lazy-edit).
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, isAbsolute, resolve, sep } from 'node:path';
import { applyEditBlocks, mergeLazyEdit, type EditBlock } from './morph';

/**
 * Contenção de path (defesa-em-profundidade contra path-traversal). Um caminho de
 * criação vindo do TEXTO da issue (guiado pelo LLM/CEO) NÃO pode escrever fora do
 * repositório. Rejeita absolutos e qualquer `..` que escape a raiz: resolve o path
 * relativo contra a raiz e exige que o resultado seja a própria raiz ou esteja
 * estritamente DENTRO dela.
 */
export function isInsideRepo(repoPath: string, relPath: string): boolean {
  if (isAbsolute(relPath)) return false;
  const root = resolve(repoPath);
  const abs = resolve(root, relPath);
  return abs === root || abs.startsWith(root + sep);
}

/** Remove cercas markdown (```diff ... ```) que o modelo às vezes adiciona. */
export function stripFences(text: string): string {
  const fence = text.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/);
  return (fence ? fence[1] : text).trim();
}

export interface DiffSnapshot {
  entries: Array<{ path: string; existed: boolean; content: string | null }>;
}

export interface RewriteResult {
  applied: boolean;
  snapshot?: DiffSnapshot;
  changedLines: number;
  error?: string;
}

/** Conta linhas que diferem entre dois textos (estimativa simples por linha). */
function countChangedLines(before: string, after: string): number {
  const a = before.split('\n');
  const b = after.split('\n');
  const setA = new Map<string, number>();
  for (const l of a) setA.set(l, (setA.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of b) {
    const n = setA.get(l);
    if (n && n > 0) {
      common++;
      setA.set(l, n - 1);
    }
  }
  return Math.max(a.length, b.length) - common;
}

/**
 * Aplica uma REESCRITA de arquivo inteiro: snapshota, escreve o novo conteúdo e
 * devolve o snapshot (pra rollback) + nº de linhas alteradas. Usado quando o
 * executor local gera o arquivo completo em vez de um unified diff.
 */
export function applyWholeFile(
  repoPath: string,
  relPath: string,
  newContent: string,
): RewriteResult {
  if (!isInsideRepo(repoPath, relPath)) {
    return { applied: false, changedLines: 0, error: 'caminho fora do repositório rejeitado' };
  }
  const abs = join(resolve(repoPath), relPath);
  try {
    const existed = existsSync(abs);
    const before = existed ? readFileSync(abs, 'utf-8') : '';
    const snap: DiffSnapshot = {
      entries: [{ path: relPath, existed, content: existed ? before : null }],
    };
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, newContent, 'utf-8');
    return { applied: true, snapshot: snap, changedLines: countChangedLines(before, newContent) };
  } catch (e) {
    const err = e as { message?: string };
    return { applied: false, changedLines: 0, error: err.message ?? 'falha ao escrever arquivo' };
  }
}

/**
 * Aplica blocos SEARCH/REPLACE (via morph.ts) a um arquivo: snapshota o estado
 * atual, calcula o conteúdo mesclado de forma determinística e escreve. Retorna
 * o snapshot pra rollback + nº de linhas alteradas. Se nenhum bloco casar, NÃO
 * escreve nada e devolve o motivo (caller escala/repara).
 */
export function applyMorphEdits(
  repoPath: string,
  relPath: string,
  blocks: EditBlock[],
): RewriteResult & { mergedContent?: string; appliedBlocks?: number } {
  if (!isInsideRepo(repoPath, relPath)) {
    return { applied: false, changedLines: 0, error: 'caminho fora do repositório rejeitado' };
  }
  const abs = join(resolve(repoPath), relPath);
  try {
    const existed = existsSync(abs);
    const before = existed ? readFileSync(abs, 'utf-8') : '';
    const res = applyEditBlocks(before, blocks);
    if (!res.ok) {
      return { applied: false, changedLines: 0, error: res.reason };
    }
    const snap: DiffSnapshot = {
      entries: [{ path: relPath, existed, content: existed ? before : null }],
    };
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, res.content, 'utf-8');
    return {
      applied: true,
      snapshot: snap,
      changedLines: countChangedLines(before, res.content),
      mergedContent: res.content,
      appliedBlocks: res.applied,
    };
  } catch (e) {
    const err = e as { message?: string };
    return { applied: false, changedLines: 0, error: err.message ?? 'falha ao aplicar edits' };
  }
}

/**
 * Aplica um EDIT PREGUIÇOSO (lazy, estilo Morph) a um arquivo: snapshota, funde
 * de forma determinística (mergeLazyEdit) e escreve. Se as âncoras não casarem,
 * NÃO escreve nada e devolve o motivo (caller repara/escala).
 */
export function applyLazyEdit(
  repoPath: string,
  relPath: string,
  update: string,
): RewriteResult & { mergedContent?: string; appliedBlocks?: number } {
  if (!isInsideRepo(repoPath, relPath)) {
    return { applied: false, changedLines: 0, error: 'caminho fora do repositório rejeitado' };
  }
  const abs = join(resolve(repoPath), relPath);
  try {
    const existed = existsSync(abs);
    const before = existed ? readFileSync(abs, 'utf-8') : '';
    const res = mergeLazyEdit(before, update);
    if (!res.ok) {
      return { applied: false, changedLines: 0, error: res.reason };
    }
    const snap: DiffSnapshot = {
      entries: [{ path: relPath, existed, content: existed ? before : null }],
    };
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, res.content, 'utf-8');
    return {
      applied: true,
      snapshot: snap,
      changedLines: countChangedLines(before, res.content),
      mergedContent: res.content,
      appliedBlocks: res.applied,
    };
  } catch (e) {
    const err = e as { message?: string };
    return { applied: false, changedLines: 0, error: err.message ?? 'falha ao aplicar lazy edit' };
  }
}

export function rollbackSnapshot(repoPath: string, snap: DiffSnapshot): void {
  for (const e of snap.entries) {
    // Defesa-em-profundidade: nunca restaura/apaga um caminho que escape o repo
    // (um snapshot só deveria conter paths internos, mas não confiamos cegamente).
    if (!isInsideRepo(repoPath, e.path)) continue;
    const abs = join(resolve(repoPath), e.path);
    try {
      if (e.existed && e.content !== null) {
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, e.content, 'utf-8');
      } else if (!e.existed && existsSync(abs)) {
        unlinkSync(abs);
      }
    } catch (err) {
      console.warn('[smart-exec] rollback falhou pra', e.path, err);
    }
  }
}

export interface ApplyResult {
  applied: boolean;
  error?: string;
  snapshot?: DiffSnapshot;
}
