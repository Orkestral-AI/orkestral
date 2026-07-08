/**
 * Contrato da Cápsula: derivação e verificação DETERMINÍSTICA dos asserts. São
 * GUARD-RAILS anti-regressão (verificam sintoma — símbolo presente, imports intactos,
 * não-encolhimento — não provam comportamento). Rodam local, baratíssimo, SEM modelo.
 * Reusa os guards que o Forge já tem (droppedTopLevelImports). Pega "trabalho errado"
 * que hoje passa verde (ex.: arquivo gravado sem o símbolo pedido, imports comidos).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { droppedTopLevelImports } from '../smart-exec/morph';
import type { ContractAssert, CapsuleTarget } from '../../../shared/types/capsule';

/** Identificador citado na instrução (função/símbolo a garantir presente). */
const IDENT_CALL_RE = /\b([A-Za-z_$][A-Za-z0-9_$]{2,})\s*\(/g;
/** Keywords da linguagem que NÃO são símbolos a verificar (evita asserts falsos). */
const LANG_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'return',
  'function',
  'catch',
  'await',
  'typeof',
  'new',
  'finally',
  'try',
  'delete',
  'throw',
  'do',
  'case',
  'var',
  'let',
  'const',
  'class',
  'async',
  'super',
  'void',
  'yield',
  'import',
  'export',
  'in',
  'of',
  'instanceof',
]);

/** Remove comentários de linha e de bloco pra não derivar assert de código comentado no done. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Deriva os asserts de um alvo a partir do `done` + `delta` (determinístico).
 * - EDIÇÃO de arquivo existente: símbolo chamado citado → `file_contains`; + `imports_intact`
 *   e `no_shrink_gt` (anti-regressão).
 * - CRIAÇÃO: NENHUM file_contains (o conteúdo do arquivo novo não é previsível pelo done —
 *   um símbolo só CHAMADO não precisa APARECER no arquivo; gerava falso-negativo que
 *   rejeitava arquivo válido). Criação é coberta por degeneração + build/QA.
 */
export function deriveAsserts(target: CapsuleTarget, done: string): ContractAssert[] {
  if (target.op !== 'edit') return [];
  const asserts: ContractAssert[] = [];
  const text = stripComments(`${done} ${target.delta}`);
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  IDENT_CALL_RE.lastIndex = 0;
  while ((m = IDENT_CALL_RE.exec(text)) !== null) {
    const id = m[1];
    if (LANG_KEYWORDS.has(id)) continue;
    if (seen.has(id) || seen.size >= 2) continue;
    seen.add(id);
    asserts.push({ kind: 'file_contains', file: target.file, needle: `${id}(` });
  }
  asserts.push({ kind: 'imports_intact', file: target.file });
  asserts.push({ kind: 'no_shrink_gt', file: target.file, ratio: 0.5 });
  return asserts;
}

export interface AssertFailure {
  assert: ContractAssert;
  reason: string;
}

/**
 * Roda os asserts contra o estado APÓS o edit. `beforeByFile` traz o conteúdo ANTES
 * (pra imports_intact / no_shrink). Retorna a 1ª falha (ou null se tudo passou).
 */
export function runAsserts(
  asserts: ContractAssert[],
  repoPath: string,
  beforeByFile: Map<string, string>,
): AssertFailure | null {
  for (const a of asserts) {
    const abs = join(repoPath, a.file);
    const after = existsSync(abs) ? readFileSync(abs, 'utf-8') : '';
    switch (a.kind) {
      case 'file_contains':
        if (!after.includes(a.needle)) {
          return { assert: a, reason: `"${a.needle}" não está em ${a.file} após o edit` };
        }
        break;
      case 'file_absent_of':
        if (after.includes(a.needle)) {
          return { assert: a, reason: `"${a.needle}" deveria ter sumido de ${a.file}` };
        }
        break;
      case 'symbol_exists':
        if (!new RegExp(`\\b${a.symbol}\\b`).test(after)) {
          return { assert: a, reason: `símbolo ${a.symbol} ausente em ${a.file}` };
        }
        break;
      case 'imports_intact': {
        const before = beforeByFile.get(a.file);
        if (before && droppedTopLevelImports(before, after)) {
          return { assert: a, reason: `imports de topo foram removidos em ${a.file}` };
        }
        break;
      }
      case 'no_shrink_gt': {
        const before = beforeByFile.get(a.file);
        if (before && before.length > 0 && after.length < before.length * (1 - a.ratio)) {
          return {
            assert: a,
            reason: `${a.file} encolheu demais (${before.length}→${after.length} chars)`,
          };
        }
        break;
      }
    }
  }
  return null;
}
